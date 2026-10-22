#!/usr/bin/env node
// gateway/daemon.js
//
// Crash-resilient parent for the gateway process. It exists because a
// single-process Node gateway cannot restart itself after a hard crash:
// something outside the crashed process must own the restart loop.
//
// The daemon:
// - spawns gateway/server.js and forwards stdout/stderr into one rotating log;
// - restarts the child after a non-zero exit or signal, with capped backoff;
// - treats a clean exit (HTTP shutdown, Ctrl+C) as final and exits itself;
// - watches a stop marker so `nanoai gateway stop` works on Windows, where
//   SIGTERM does not reach a JS signal handler;
// - asks the gateway to shut down gracefully through its authenticated HTTP
//   endpoint before falling back to process-tree termination.
//
// It is intentionally a small process with no database access and no agent
// imports, so a bug in the gateway cannot poison the restart path.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CONFIG_FILENAME, dataDir } from "#src/shared/data-dir.js";
import {
  childPidFileFor,
  logFileFor,
  stopFileFor,
} from "#src/shared/gateway-paths.js";
import { createLogger } from "#src/infra/logger.js";
import { isWindows, killProcessTree } from "#src/infra/platform.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENTRY = path.join(__dirname, "server.js");
const DEFAULT_RESTART_BASE_MS = 1_000;
const DEFAULT_RESTART_MAX_MS = 30_000;
const DEFAULT_STABLE_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 12_000;
const STOP_POLL_MS = 250;

function positiveInteger(value, fallback) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

/** Exponential backoff with a hard ceiling. Attempt starts at 1. */
export function restartDelay(
  attempt,
  { baseMs = DEFAULT_RESTART_BASE_MS, maxMs = DEFAULT_RESTART_MAX_MS } = {},
) {
  const n = Math.max(1, Number.isInteger(attempt) ? attempt : 1);
  const base = Math.max(1, positiveInteger(baseMs, DEFAULT_RESTART_BASE_MS));
  const ceiling = Math.max(base, positiveInteger(maxMs, DEFAULT_RESTART_MAX_MS));
  return Math.min(ceiling, base * 2 ** Math.min(n - 1, 16));
}

function readConfig() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dataDir(), CONFIG_FILENAME), "utf8"),
    );
  } catch {
    return null;
  }
}

function readListenAddress() {
  const config = readConfig();
  const rawPort = process.env.PORT ?? config?.gateway?.port ?? 3060;
  const port = Number(rawPort);
  const rawHost = process.env.HOST ?? config?.gateway?.host ?? "127.0.0.1";
  let host = typeof rawHost === "string" && rawHost.trim() !== ""
    ? rawHost.trim()
    : "127.0.0.1";
  if (host === "0.0.0.0" || host === "::" || host === "[::]") host = "127.0.0.1";
  return {
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3060,
    host,
  };
}

function readGatewayToken() {
  if (process.env.NANO_GATEWAY_TOKEN) return process.env.NANO_GATEWAY_TOKEN;
  const config = readConfig();
  return typeof config?.gateway_token === "string" && config.gateway_token !== ""
    ? config.gateway_token
    : null;
}

function baseUrl() {
  const { port, host } = readListenAddress();
  const urlHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

function writePidFile(filePath, pid) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${pid}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // A missing child pid file only weakens manual recovery, never the daemon.
  }
}

function readStopRequest(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return false;
  }
  if (text === "") return true;
  try {
    const parsed = JSON.parse(text);
    // Ignore a stale marker written for a previous daemon pid.
    if (Number.isInteger(parsed?.pid) && parsed.pid !== process.pid) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function waitForExit(child, timeoutMs) {
  if (
    !child ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.exitCode === undefined
  ) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    child.once?.("exit", onExit);
  });
}

/**
 * Create a daemon instance. Everything that touches the outside world is
 * injectable so the restart loop can be tested without starting a real
 * gateway on a real port.
 */
export function createDaemon({
  repoRoot = path.join(__dirname, ".."),
  entry = process.env.NANO_GATEWAY_ENTRY || DEFAULT_ENTRY,
  spawnFn = spawn,
  env = process.env,
  logFile = logFileFor(),
  childPidFile = childPidFileFor(),
  stopFile = stopFileFor(),
  logger = null,
  restartBaseMs = positiveInteger(env.NANO_RESTART_BASE_MS, DEFAULT_RESTART_BASE_MS),
  restartMaxMs = positiveInteger(env.NANO_RESTART_MAX_MS, DEFAULT_RESTART_MAX_MS),
  restartLimit = positiveInteger(env.NANO_RESTART_LIMIT, 0),
  stableMs = positiveInteger(env.NANO_RESTART_STABLE_MS, DEFAULT_STABLE_MS),
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  killTree = killProcessTree,
  pollMs = STOP_POLL_MS,
  handleSignals = true,
} = {}) {
  const log =
    logger ??
    createLogger({
      name: "gateway-daemon",
      file: logFile,
      mirror:
        env.NANO_LOG_MIRROR === "1" ||
        (env.NANO_LOG_MIRROR !== "0" && process.stdout?.isTTY === true),
    });

  let child = null;
  let childStartedAt = 0;
  let childHandled = true;
  let restarts = 0;
  let stopping = false;
  let finished = false;
  let restartTimer = null;
  let stopPoll = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function clearRestartTimer() {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  function removeChildPid() {
    try {
      fs.rmSync(childPidFile, { force: true });
    } catch {
      // Best effort only.
    }
  }

  function finish(code) {
    if (finished) return;
    finished = true;
    clearRestartTimer();
    if (stopPoll) clearInterval(stopPoll);
    stopPoll = null;
    removeChildPid();
    try {
      fs.rmSync(stopFile, { force: true });
    } catch {
      // Best effort only.
    }
    log.info("Gateway daemon exited", {
      event: "gateway.daemon.exit",
      code,
      restarts,
    });
    log.flush?.();
    resolveDone(code);
  }

  function scheduleRestart(code, signal, error) {
    if (stopping || finished) return;
    const uptime = childStartedAt > 0 ? Date.now() - childStartedAt : 0;
    if (stableMs > 0 && uptime >= stableMs) {
      restarts = 0;
    }
    restarts += 1;

    if (restartLimit > 0 && restarts > restartLimit) {
      log.fatal("Gateway crashed too many times; giving up", {
        event: "gateway.daemon.restart-limit",
        code,
        signal,
        error,
        restarts,
        restartLimit,
      });
      finish(1);
      return;
    }

    const waitMs = restartDelay(restarts, {
      baseMs: restartBaseMs,
      maxMs: restartMaxMs,
    });
    log.warn("Gateway exited unexpectedly; restarting", {
      event: "gateway.daemon.restart",
      code,
      signal,
      error,
      restarts,
      waitMs,
    });
    clearRestartTimer();
    // Keep this timer referenced: while the child is down it is the only
    // handle that keeps the daemon alive long enough to perform the restart.
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnChild();
    }, waitMs);
  }

  function handleExit(code, signal, error = null) {
    if (childHandled) return;
    childHandled = true;
    child = null;
    removeChildPid();
    if (stopping) return;
    if (code === 0 && !signal && !error) {
      log.info("Gateway exited cleanly; daemon will not restart", {
        event: "gateway.daemon.clean-exit",
      });
      finish(0);
      return;
    }
    scheduleRestart(code, signal, error);
  }

  function spawnChild() {
    if (stopping || finished) return;
    childHandled = false;
    childStartedAt = Date.now();
    let spawned;
    try {
      spawned = spawnFn(process.execPath, [entry], {
        cwd: repoRoot,
        env: { ...env, NANO_SUPERVISED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      handleExit(null, null, error);
      return;
    }

    child = spawned;
    if (!Number.isInteger(child?.pid) || child.pid < 1) {
      handleExit(null, null, new Error("Gateway child did not report a pid."));
      return;
    }
    writePidFile(childPidFile, child.pid);
    log.info("Gateway child started", {
      event: "gateway.daemon.child-start",
      childPid: child.pid,
      restarts,
    });

    child.stdout?.on("data", (chunk) => log.writeRaw(chunk));
    child.stderr?.on("data", (chunk) => log.writeRaw(chunk));
    child.once("error", (error) => {
      log.error("Gateway child spawn error", {
        event: "gateway.daemon.child-error",
        error,
      });
      if (!child?.pid || child.exitCode !== null) handleExit(null, null, error);
    });
    child.once("exit", (code, signal) => handleExit(code, signal));
  }

  async function requestHttpShutdown() {
    const token = readGatewayToken();
    if (!token) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`${baseUrl()}/api/v1/system/shutdown`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirm: "shutdown" }),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function stop(reason = "stop", { code = 0 } = {}) {
    if (finished) return done;
    if (stopping) return done;
    stopping = true;
    clearRestartTimer();
    log.info("Stopping gateway daemon", {
      event: "gateway.daemon.stop",
      reason,
    });

    try {
      fs.rmSync(stopFile, { force: true });
    } catch {
      // Best effort only.
    }

    if (child) {
      const accepted = await requestHttpShutdown();
      if (!accepted && !isWindows()) {
        try {
          child.kill("SIGTERM");
        } catch {
          // The child may already be gone.
        }
      }
      const exited = await waitForExit(child, shutdownTimeoutMs);
      if (!exited) {
        log.warn("Gateway did not stop in time; killing its process tree", {
          event: "gateway.daemon.force-kill",
          reason,
          childPid: child.pid,
        });
        await killTree(child.pid, { graceMs: 1_500 }).catch(() => {});
      }
    }

    finish(code);
    return done;
  }

  function checkStopMarker() {
    if (stopping || finished) return;
    if (readStopRequest(stopFile)) {
      void stop("stop-file");
    }
  }

  function start() {
    if (stopPoll || finished) return done;
    try {
      fs.rmSync(stopFile, { force: true });
      fs.rmSync(childPidFile, { force: true });
    } catch {
      // Best effort only.
    }
    log.info("Gateway daemon starting", {
      event: "gateway.daemon.start",
      pid: process.pid,
      entry,
      logFile,
    });
    // Keep the poll referenced for the same reason: a daemon waiting between
    // restarts must not disappear because every handle is unref'd.
    stopPoll = setInterval(checkStopMarker, Math.max(50, pollMs));

    if (handleSignals) {
      const onSignal = (signal) => void stop(signal);
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      if (isWindows()) process.on("SIGBREAK", onSignal);
    }

    spawnChild();
    return done;
  }

  return { start, stop, done, get child() { return child; } };
}

function isInvokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return path.basename(process.argv[1] ?? "").toLowerCase() === "daemon.js";
  }
}

if (isInvokedAsMain()) {
  // Avoid an unhandled rejection escaping after a crash. Stop the child before
  // exiting so a daemon bug does not leave an orphaned gateway holding the port.
  const daemon = createDaemon();
  process.on("uncaughtException", () => {
    // Do not call start() here: if the crash happened before the daemon was
    // initialized, starting a fresh gateway only delays the exit. stop() is
    // safe without start() and cleans up whatever child already exists.
    void daemon.stop("daemon-uncaught", { code: 1 });
  });
  process.on("unhandledRejection", (reason) => {
    void daemon.stop("daemon-unhandled-rejection", { code: 1 });
    if (reason instanceof Error) {
      // The logger in createDaemon writes the real stack through stop events.
      process.stderr.write(`${reason.stack ?? reason.message}\n`);
    }
  });
  void daemon.start().then((code) => {
    process.exitCode = code;
    // Let stdout/stderr drain before the process disappears.
    void delay(10).then(() => process.exit(code));
  });
}
