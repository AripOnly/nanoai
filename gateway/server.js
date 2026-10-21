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

// Boot order is a safety property: settings and the model catalog must be
// readable, the gateway token must exist, and the runtime must be built before
// the port accepts a request.
await initSettings();
await initModelCatalog();

const { token, created } = await getGatewayToken();

if (created) {
  console.log(
    "[nanoai] First boot: generated a gateway token and saved it to nano.config.json.",
  );
  console.log(`[nanoai] Gateway token: ${token}`);
  console.log(
    "[nanoai] Save it now. Every /api request needs: Authorization: Bearer <token>.",
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
});
try {
  await skills.init();
} catch (error) {
  console.error("[nanoai] Skill registry initialization failed:", error);
}

const jobs = createJobManager({ config: getSnapshot });

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
    console.log(
      `[nanoai] Recovered jobs: ${summary.running} running, ${summary.finished} finished, ${summary.lost} lost.`,
    );
  }
} catch (error) {
  console.error("[nanoai] Job reconciliation failed:", error);
}

const app = await createApp({ runtime, jobs, skills });

const { port: PORT, host: HOST } = resolveListen({
  gateway: getSnapshot().value.gateway,
});

// Hot settings/catalog must be observable before the first request, but after
// the initial snapshots and token bootstrap so our own writes are not reloaded
// as external edits. Both watchers are stopped on every failure and shutdown.
startSettingsWatcher();
startModelCatalogWatcher();
skills.startWatcher();

function stopWatchers() {
  stopSettingsWatcher();
  stopModelCatalogWatcher();
  skills.stopWatcher();
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
      console.log(`Server is running on http://${HOST}:${PORT}`);
    },
  });
} catch (error) {
  stopWatchers();
  console.error("[nanoai] Boot failed:", error);
  process.exit(1);
}

const { server, recovered } = booted;
if (recovered > 0) {
  console.log(
    `[nanoai] Recovered ${recovered} interrupted turn(s) from the previous run.`,
  );
}

// Now that session recovery is complete and the port is bound, turn persisted
// pending notifications into notice turns. This never blocks startup.
jobs.setCompletionHandler((job) => jobNotice.enqueue(job));
void jobNotice.start().catch((error) => {
  console.error("[nanoai] Job notice dispatch failed:", error);
});

// A stale instance still holding the port is the most common boot failure
// (e.g. rapid restarts). Say so plainly instead of dumping EADDRINUSE.
server.on("error", (error) => {
  stopWatchers();
  jobs.dispose();
  if (error?.code === "EADDRINUSE") {
    console.error(
      `[nanoai] Port ${PORT} on ${HOST} is already in use. Another gateway instance is probably still running — stop it first, then boot again.`,
    );
    process.exit(1);
    return;
  }
  console.error("[nanoai] Server error:", error);
  process.exit(1);
});

// SSE agent streams can run for a long time; do not let Node's default
// request timeout kill them. Auth and (later) rate limiting are the real
// protections, not a short idle timer.
server.requestTimeout = 0;

async function shutdown(signal) {
  console.log(`[nanoai] Received ${signal}, shutting down...`);

  // Arm the hard stop before any await: a wedged notice turn or socket must
  // not be able to keep the process alive indefinitely.
  const forceExit = setTimeout(() => {
    console.log("[nanoai] Shutdown timed out, forcing exit.");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  // Stop observing files before closing sockets; no reload should race the
  // shutdown path.
  stopWatchers();

  // Stop provider/tool work first. The controllers' generators then commit
  // their partial turns before server.close() finishes waiting for sockets.
  abortActiveTurns(new Error(`Gateway shutdown (${signal})`));
  // Stop auto-continue first. Dispose watchers but NEVER kill detached jobs:
  // they are supposed to outlive the gateway.
  await jobNotice.dispose();
  jobs.dispose();
  runtime.dispose?.();

  server.close(() => {
    try {
      closeDatabase();
    } catch {
      // Already closed or never opened; nothing to do.
    }
    console.log("[nanoai] Shutdown complete.");
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
