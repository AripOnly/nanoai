// apps/console/lib/supervisor.js
//
// Gateway process supervision behind the `nanoai` command (one-shot CLI:
// `nanoai gateway start|stop|restart|status|log`, `nanoai cli`, `nanoai web`).
// The gateway runs DETACHED (survives terminal close, required for 24/7),
// tracked via a pidfile, logging to a file. Pure logic + small spawn wrapper,
// unit-tested with real stub processes (never the real gateway).
//
// Since Fase 6 the detached entry point is gateway/daemon.js, not
// gateway/server.js: the daemon owns the crash-restart loop and rotates the
// operational log. This module starts/stops that daemon and reads its files.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getSnapshot, initSettings } from "#src/config/index.js";
import {
  childPidFileFor,
  consoleLogFileFor,
  logFileFor,
  pidFileFor,
  stopFileFor,
} from "#src/shared/gateway-paths.js";

export {
  childPidFileFor,
  consoleLogFileFor,
  logFileFor,
  pidFileFor,
  stopFileFor,
};

const DEFAULT_PORT = 3060;
const MAX_LOG_TAIL_BYTES = 256 * 1024;
// The daemon itself waits up to 12s for the gateway child before force-killing
// it, so the CLI budget must be larger or it races that graceful stop.
const STOP_WAIT_MS = 20_000;
const STOP_WAIT_WITHOUT_HTTP_MS = 3_000;

export function dashboardUrl(port = DEFAULT_PORT) {
  return `http://localhost:${port}/`;
}

/**
 * Parse `nano` arguments (without node/bin prefix) into a command.
 * Bare invocation prints help, like git/docker.
 */
export function parseArgs(argv = []) {
  const words = argv.map((word) => String(word));
  if (words.length === 0) return { name: "help", args: [] };
  const [head, ...rest] = words;
  const lower = head.toLowerCase();
  if (lower === "-h" || lower === "--help" || lower === "help") {
    return { name: "help", args: [] };
  }
  if (lower === "-v" || lower === "--version" || lower === "version") {
    return { name: "version", args: [] };
  }
  if (lower === "gateway" && ["start", "stop", "restart", "status", "log"].includes((rest[0] ?? "").toLowerCase())) {
    return { name: `gateway:${rest[0].toLowerCase()}`, args: rest.slice(1) };
  }
  if (["cli", "web", "doctor", "skills"].includes(lower)) {
    return { name: lower, args: rest };
  }
  return { name: "unknown", args: words, raw: words.join(" ") };
}

export function helpText() {
  return [
    "nanoai — one agent, many doors.",
    "",
    "Usage: nanoai <command>  (works from any folder)",
    "",
    "  nanoai gateway start     start the backend in the background (+ web UI)",
    "                           auto-restarts the gateway after a crash",
    "  nanoai gateway stop      stop the backend gracefully",
    "  nanoai gateway restart   restart the backend",
    "  nanoai gateway status    show backend state (pid, health)",
    "  nanoai gateway log [n]   show the last n backend log lines (default 20)",
    "  nanoai cli               enter chat mode (needs the gateway running)",
    "  nanoai web               print the dashboard URL",
    "  nanoai doctor            check installation health (node, db, settings, search)",
    "  nanoai skills add <src>  install a skill explicitly via skills.sh",
    "  nanoai skills list       list installed skills",
    "  nanoai skills inspect <name>  show a skill and its provenance",
    "  nanoai skills update <name>   reinstall from recorded provenance",
    "  nanoai skills remove <name>   remove a user-installed skill",
    "  nanoai skills reload     rebuild the registry / reload the gateway",
    "  nanoai -h, --help        show this help",
  ].join("\n");
}

/** True when a process with this pid exists (stale pidfiles must be cleaned). */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(pidFile) {
  try {
    const text = fs.readFileSync(pidFile, "utf8").trim();
    const pid = Number.parseInt(text, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pidFile, pid) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(pid), { encoding: "utf8", mode: 0o600 });
}

function clearPid(pidFile) {
  try {
    fs.rmSync(pidFile, { force: true });
  } catch {
    // Best effort only.
  }
}

function writeStopMarker(pid) {
  const file = stopFileFor();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({ pid, at: new Date().toISOString() })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // The HTTP shutdown path still works without the marker.
  }
}

function clearStopMarker() {
  try {
    fs.rmSync(stopFileFor(), { force: true });
  } catch {
    // Best effort only.
  }
}

async function requestHttpShutdown(port) {
  let token = process.env.NANO_GATEWAY_TOKEN;
  if (!token) {
    try {
      await initSettings();
      token = getSnapshot()?.value?.gateway_token ?? null;
    } catch {
      token = null;
    }
  }
  if (!token) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/system/shutdown`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirm: "shutdown" }),
        signal: controller.signal,
      },
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function forceKill(pid) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

async function waitReady(port, timeoutMs = 30000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        const health = await response.json().catch(() => ({}));
        return { ready: true, health };
      }
    } catch {
      // Not up yet; keep polling until the budget runs out.
    }
    if (Date.now() - started > timeoutMs) {
      return { ready: false };
    }
    await delay(500);
  }
}

function readTail(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - MAX_LOG_TAIL_BYTES);
    const descriptor = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(descriptor, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return "";
  }
}

/**
 * Create a supervisor bound to a repo root + port. spawnFn is injectable so
 * tests can substitute stub children.
 */
export function createSupervisor({ repoRoot, port = DEFAULT_PORT, spawnFn = spawn } = {}) {
  if (typeof repoRoot !== "string" || repoRoot === "") {
    throw new Error("supervisor needs a repoRoot directory.");
  }
  const pidFile = pidFileFor();
  const logFile = logFileFor();
  const consoleLog = consoleLogFileFor();
  const daemonScript = path.join(repoRoot, "gateway", "daemon.js");

  function currentPid() {
    const pid = readPid(pidFile);
    if (pid === null) return null;
    if (isAlive(pid)) return pid;
    clearPid(pidFile);
    return null;
  }

  return {
    async start({ timeoutMs = 30000 } = {}) {
      const existing = currentPid();
      if (existing !== null) {
        return { ok: false, message: `Gateway already running (pid ${existing}).` };
      }
      clearStopMarker();
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      // The launch log is intentionally truncated: the daemon takes over
      // logging as soon as it starts. Keeping old launch output would grow
      // without the daemon's rotation policy.
      const out = fs.openSync(consoleLog, "w", 0o600);
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(consoleLog, 0o600);
        } catch {
          // Best effort; the file was just created with 0600 where supported.
        }
      }
      let child;
      try {
        child = spawnFn(process.execPath, [daemonScript], {
          cwd: repoRoot,
          stdio: ["ignore", out, out],
          windowsHide: true,
          detached: true,
        });
      } catch (error) {
        try {
          fs.closeSync(out);
        } catch {
          // Ignore close errors on a failed spawn.
        }
        return { ok: false, message: `Failed to start gateway: ${error instanceof Error ? error.message : String(error)}` };
      }
      try {
        fs.closeSync(out);
      } catch {
        // The child keeps its own descriptor; ours can go.
      }
      if (child.unref) child.unref();
      if (typeof child.pid !== "number") {
        return { ok: false, message: "Gateway process did not start (no pid)." };
      }
      writePid(pidFile, child.pid);
      const { ready, health } = await waitReady(port, timeoutMs);
      if (!ready) {
        writeStopMarker(child.pid);
        await delay(500);
        forceKill(child.pid);
        clearPid(pidFile);
        clearStopMarker();
        return { ok: false, message: `Gateway did not answer /health within ${Math.round(timeoutMs / 1000)}s. See 'nanoai gateway log'.` };
      }
      return { ok: true, message: `Gateway running (pid ${child.pid}, v${health?.version ?? "?"}). Web: ${dashboardUrl(port)}` };
    },

    async stop() {
      const pid = currentPid();
      if (pid === null) {
        clearStopMarker();
        return { ok: false, message: "Gateway is not running." };
      }

      writeStopMarker(pid);
      const accepted = await requestHttpShutdown(port);
      const budget = accepted ? STOP_WAIT_MS : STOP_WAIT_WITHOUT_HTTP_MS;
      const deadline = Date.now() + budget;
      let gone = !isAlive(pid);
      while (!gone && Date.now() < deadline) {
        await delay(100);
        gone = !isAlive(pid);
      }

      if (!gone) {
        // A wedged daemon must still be stopped, and on Windows `/T` also
        // takes the gateway child with it.
        forceKill(pid);
        const killDeadline = Date.now() + 2_000;
        while (!gone && Date.now() < killDeadline) {
          await delay(100);
          gone = !isAlive(pid);
        }
      }

      clearPid(pidFile);
      clearStopMarker();
      return gone
        ? { ok: true, message: "Gateway stopped." }
        : { ok: false, message: `Process ${pid} did not exit. Stop it manually.` };
    },

    async restart(options = {}) {
      await this.stop();
      return this.start(options);
    },

    async status() {
      const pid = currentPid();
      if (pid === null) {
        return { running: false, message: `Gateway is not running (port ${port}). Use 'nanoai gateway start'.` };
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (!response.ok) {
          return { running: true, pid, message: `Gateway process alive (pid ${pid}) but unhealthy (HTTP ${response.status}).` };
        }
        const health = await response.json().catch(() => ({}));
        return {
          running: true,
          pid,
          message: `Gateway running (pid ${pid}, v${health?.version ?? "?"}, uptime ${health?.uptime ?? "?"}s). Web: ${dashboardUrl(port)}`,
        };
      } catch {
        return { running: true, pid, message: `Gateway process alive (pid ${pid}) but not answering /health yet.` };
      }
    },

    logTail(count = 20) {
      const n = Number.isInteger(count) && count > 0 ? count : 20;
      // The launch log only carries output written before the daemon opened
      // the rotating log; show it first so early boot failures are not lost.
      const text = [readTail(consoleLog), readTail(logFile)]
        .filter((part) => part.trim() !== "")
        .join("\n");
      if (text === "") return "(no backend log captured yet)";
      const lines = text.split("\n").filter((line) => line.trim() !== "");
      const tail = lines.slice(-n);
      return tail.length > 0 ? tail.join("\n") : "(no backend log captured yet)";
    },
  };
}
