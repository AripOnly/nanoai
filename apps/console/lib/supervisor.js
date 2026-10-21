// apps/console/lib/supervisor.js
//
// Gateway process supervision behind the `nanoai` command (one-shot CLI:
// `nanoai gateway start|stop|restart|status|log`, `nanoai cli`, `nanoai web`).
// The gateway runs DETACHED (survives terminal close, required for 24/7),
// tracked via a pidfile, logging to a file. Pure logic + small spawn wrapper,
// unit-tested with real stub processes (never the real gateway).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "#src/shared/data-dir.js";

const DEFAULT_PORT = 3060;
const MAX_LOG_TAIL_BYTES = 256 * 1024;

export function pidFileFor() {
  return path.join(dataDir(), "gateway.pid");
}

export function logFileFor() {
  return path.join(dataDir(), "logs", "gateway.log");
}

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
    "  nanoai gateway stop      stop the backend",
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
  fs.writeFileSync(pidFile, String(pid), "utf8");
}

function clearPid(pidFile) {
  try {
    fs.rmSync(pidFile, { force: true });
  } catch {
    // Best effort only.
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function waitExit(child, timeoutMs = 8000) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Create a supervisor bound to a repo root + port. spawnFn is injectable so
 * tests can substitute stub children.
 */
export function createSupervisor({ repoRoot, port = DEFAULT_PORT, spawnFn = spawn } = {}) {
  if (typeof repoRoot !== "string" || repoRoot === "") {
    throw new Error("supervisor needs a repoRoot directory.");
  }
  const pidFile = pidFileFor(repoRoot);
  const logFile = logFileFor(repoRoot);

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
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const out = fs.openSync(logFile, "a");
      let child;
      try {
        child = spawnFn(process.execPath, ["gateway/server.js"], {
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
        try {
          child.kill();
        } catch {
          // Already gone; pidfile cleanup below still applies.
        }
        clearPid(pidFile);
        return { ok: false, message: `Gateway did not answer /health within ${Math.round(timeoutMs / 1000)}s. See 'nanoai gateway log'.` };
      }
      return { ok: true, message: `Gateway running (pid ${child.pid}, v${health?.version ?? "?"}). Web: ${dashboardUrl(port)}` };
    },
    async stop() {
      const pid = currentPid();
      if (pid === null) {
        return { ok: false, message: "Gateway is not running." };
      }
      try {
        process.kill(pid);
      } catch {
        clearPid(pidFile);
        return { ok: false, message: "Gateway process already gone (stale pidfile cleaned)." };
      }
      const deadline = Date.now() + 8000;
      let gone = !isAlive(pid);
      while (!gone && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        gone = !isAlive(pid);
      }
      clearPid(pidFile);
      return gone
        ? { ok: true, message: "Gateway stopped." }
        : { ok: false, message: `Process ${pid} did not exit in 8s. Stop it manually.` };
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
      let text = "";
      try {
        const stat = fs.statSync(logFile);
        const start = Math.max(0, stat.size - MAX_LOG_TAIL_BYTES);
        const descriptor = fs.openSync(logFile, "r");
        try {
          const buffer = Buffer.alloc(stat.size - start);
          fs.readSync(descriptor, buffer, 0, buffer.length, start);
          text = buffer.toString("utf8");
        } finally {
          fs.closeSync(descriptor);
        }
      } catch {
        return "(no backend log captured yet)";
      }
      const lines = text.split("\n").filter((line) => line.trim() !== "");
      const tail = lines.slice(-n);
      return tail.length > 0 ? tail.join("\n") : "(no backend log captured yet)";
    },
  };
}
