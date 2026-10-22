// gateway/server.js
//
// The composition root. This is the only place that wires settings, the model
// catalog, the provider registry, the runtime, and the Express transport
// together; everything else receives its dependencies explicitly.

import { createApp } from "./application/web.js";
import { getGatewayToken } from "./auth/token.js";
import { closeDatabase } from "../src/session/index.js";
import sessionService from "./service/session-service.js";
import { bootGateway, resolveListen } from "./boot.js";
import { abortActiveTurns } from "./lifecycle/active-turns.js";
import {
  getSnapshot,
  initSettings,
  startSettingsWatcher,
  stopSettingsWatcher,
} from "../src/config/index.js";
import {
  getCatalogSnapshot,
  initModelCatalog,
  startModelCatalogWatcher,
  stopModelCatalogWatcher,
} from "../src/models/index.js";
import { getProviderRegistry } from "../src/llm/registry.js";
import { createRuntime, createJobNotice } from "../src/runtime/index.js";
import { createJobManager } from "../src/jobs/index.js";
import { createSkillRegistry } from "../src/skills/index.js";
import { toolRegistry } from "../src/tools/registry.js";
import { createLogger } from "../src/infra/logger.js";
import { startAttachmentCleanup } from "../src/infra/attachments.js";

const logger = createLogger({
  name: "gateway",
  level: process.env.NANO_LOG_LEVEL ?? "info",
});
let shuttingDown = false;

// Boot order is a safety property: settings and the model catalog must be
// readable, the gateway token must exist, and the runtime must be built before
// the port accepts a request.
await initSettings();
await initModelCatalog();

const { token, created } = await getGatewayToken();

if (created) {
  logger.info(
    "First boot: generated a gateway token and saved it to nano.config.json.",
    { event: "gateway.token.created" },
  );
  // The token is printed exactly once so the operator can copy it. It is
  // deliberately not passed through the structured logger's field redaction.
  console.log(`[nanoai] Gateway token: ${token}`);
  logger.info(
    "Save the token now. Every /api request needs: Authorization: Bearer <token>.",
    { event: "gateway.token.notice" },
  );
}

// Skill metadata is validated before any request or job turn can use it. A
// broken skill file must not prevent the gateway from booting; the registry
// keeps the last-known-good snapshot and reports the error through /health.
const knownSkillTools = toolRegistry
  .names()
  .filter((name) => name !== "loadSkill" && name !== "searchSkills");
const skills = createSkillRegistry({
  config: getSnapshot,
  knownTools: knownSkillTools,
  logger,
});
try {
  await skills.init();
} catch (error) {
  logger.error("Skill registry initialization failed", {
    event: "gateway.skills.init.failed",
    error,
  });
}

const jobs = createJobManager({ config: getSnapshot, logger });

const runtime = createRuntime({
  providers: getProviderRegistry(),
  config: getSnapshot,
  catalog: getCatalogSnapshot,
  jobs,
  skills,
});

const jobNotice = createJobNotice({
  runtime,
  jobs,
  config: getSnapshot,
});

// Reconcile detached jobs BEFORE the port opens. A job that finished while the
// gateway was down is finalized here; pending notices are only dispatched after
// session recovery and listen, below. The completion handler is intentionally
// installed later so reconciliation cannot race session recovery.
try {
  const summary = await jobs.init();
  if (summary.inspected > 0) {
    logger.info("Recovered background jobs", {
      event: "gateway.jobs.recovered",
      ...summary,
    });
  }
} catch (error) {
  logger.error("Job reconciliation failed", {
    event: "gateway.jobs.reconcile.failed",
    error,
  });
}

const app = await createApp({
  runtime,
  jobs,
  skills,
  logger,
  shutdown: (reason) => shutdown(reason),
});

const { port: PORT, host: HOST } = resolveListen({
  gateway: getSnapshot().value.gateway,
});

// Hot settings/catalog must be observable before the first request, but after
// the initial snapshots and token bootstrap so our own writes are not reloaded
// as external edits. Both watchers are stopped on every failure and shutdown.
startSettingsWatcher();
startModelCatalogWatcher();
skills.startWatcher();
const stopAttachmentCleanup = startAttachmentCleanup();

function stopWatchers() {
  stopSettingsWatcher();
  stopModelCatalogWatcher();
  skills.stopWatcher();
  stopAttachmentCleanup();
}

let booted;
try {
  // Recovery runs inside bootGateway, before the port starts accepting
  // requests. A fresh request must never race the interrupted-turn sweep.
  booted = bootGateway({
    app,
    sessionService,
    port: PORT,
    host: HOST,
    onListen: () => {
      logger.info("Server is running", {
        event: "gateway.listen",
        host: HOST,
        port: PORT,
        url: `http://${HOST}:${PORT}`,
      });
    },
  });
} catch (error) {
  stopWatchers();
  logger.error("Boot failed", { event: "gateway.boot.failed", error });
  process.exit(1);
}

const { server, recovered } = booted;
if (recovered > 0) {
  logger.info("Recovered interrupted turns", {
    event: "gateway.turns.recovered",
    count: recovered,
  });
}

// Now that session recovery is complete and the port is bound, turn persisted
// pending notifications into notice turns. This never blocks startup.
jobs.setCompletionHandler((job) => jobNotice.enqueue(job));
void jobNotice.start().catch((error) => {
  logger.error("Job notice dispatch failed", {
    event: "gateway.job-notice.failed",
    error,
  });
});

// A stale instance still holding the port is the most common boot failure
// (e.g. rapid restarts). Say so plainly instead of dumping EADDRINUSE.
server.on("error", (error) => {
  stopWatchers();
  jobs.dispose();
  if (error?.code === "EADDRINUSE") {
    logger.error(
      `Port ${PORT} on ${HOST} is already in use. Another gateway instance is probably still running — stop it first, then boot again.`,
      { event: "gateway.listen.eaddrinuse", port: PORT, host: HOST },
    );
    process.exit(1);
    return;
  }
  logger.error("Server error", { event: "gateway.server.error", error });
  process.exit(1);
});

// SSE agent streams can run for a long time; do not let Node's default
// request timeout kill them. Auth and (later) rate limiting are the real
// protections, not a short idle timer.
server.requestTimeout = 0;

async function shutdown(reason = "shutdown") {
  if (shuttingDown) {
    logger.warn("Shutdown already in progress", {
      event: "gateway.shutdown.duplicate",
      reason,
    });
    return;
  }
  shuttingDown = true;
  logger.info("Shutting down", { event: "gateway.shutdown.start", reason });

  // Arm the hard stop before any await: a wedged notice turn or socket must
  // not be able to keep the process alive indefinitely.
  const forceExit = setTimeout(() => {
    logger.error("Shutdown timed out, forcing exit", {
      event: "gateway.shutdown.timeout",
      reason,
    });
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  // Stop observing files before closing sockets; no reload should race the
  // shutdown path.
  stopWatchers();

  // Stop provider/tool work first. The controllers' generators then commit
  // their partial turns before server.close() finishes waiting for sockets.
  // Each step is best-effort: one broken disposer must not prevent the rest of
  // the shutdown path (or turn a deliberate stop into a daemon restart).
  const runStep = async (step, fn) => {
    try {
      await fn();
    } catch (error) {
      logger.error("Shutdown step failed", {
        event: "gateway.shutdown.step.failed",
        step,
        error,
      });
    }
  };
  await runStep("abort-turns", () =>
    abortActiveTurns(new Error(`Gateway shutdown (${reason})`)),
  );
  // Stop auto-continue first. Dispose watchers but NEVER kill detached jobs:
  // they are supposed to outlive the gateway.
  await runStep("job-notice", () => jobNotice.dispose());
  await runStep("jobs", () => jobs.dispose());
  await runStep("runtime", () => runtime.dispose?.());

  server.close(() => {
    try {
      closeDatabase();
    } catch {
      // Already closed or never opened; nothing to do.
    }
    logger.info("Shutdown complete", {
      event: "gateway.shutdown.complete",
      reason,
    });
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// A crash must be observable and must produce a non-zero exit so the daemon
// restarts the gateway. Without these handlers Node may exit silently on an
// unhandled rejection or leave a half-dead process behind.
process.on("uncaughtException", (error) => {
  logger.fatal("Uncaught exception", {
    event: "gateway.process.uncaught",
    error,
  });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.fatal("Unhandled rejection", {
    event: "gateway.process.unhandled-rejection",
    error: reason,
  });
  process.exit(1);
});
