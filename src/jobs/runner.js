#!/usr/bin/env node
// src/jobs/runner.js
//
// Detached job runner. This file is deliberately standalone: it may import
// only Node builtins and ./kill-tree.js. It never opens SQLite, reads settings,
// looks up sessions/providers, or calls the agent loop. Its entire contract is
// the job directory:
//
//   spec.json (in) -> output.log, runner.pid, child.pid, result.json (out)
//
// Timeout and explicit kill requests share one idempotent kill path.

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { killProcessTree } from "./kill-tree.js";

const DEFAULT_MAX_LOG_BYTES = 50 * 1024 * 1024;
const MAX_LOG_BYTES = 1024 * 1024 * 1024;
const KILL_GRACE_MS = 5000;
const KILL_POLL_MS = 250;

function argument(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function writePid(filePath, pid) {
  try {
    fs.writeFileSync(filePath, `${pid}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  } catch {
    // A missing pid file degrades reconciliation, never the job itself.
  }
}

function writeResult(resultPath, result) {
  const directory = path.dirname(resultPath);
  const tempPath = path.join(
    directory,
    `.result.json.${process.pid}.${Date.now()}.tmp`,
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tempPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, resultPath);
  try {
    fs.chmodSync(resultPath, 0o600);
  } catch {
    // Windows has no POSIX mode bits.
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const specPath = argument("--spec");
  const jobId = argument("--job-id");
  const tag = argument("--tag");

  if (!specPath || !jobId) {
    process.exit(2);
  }
  if (tag && tag !== "nanoai-job-runner") {
    process.exit(2);
  }

  let spec;
  try {
    spec = JSON.parse(await fsp.readFile(specPath, "utf8"));
  } catch {
    process.exit(2);
  }

  if (
    !spec ||
    typeof spec !== "object" ||
    spec.jobId !== jobId ||
    typeof spec.command !== "string" ||
    spec.command.trim() === "" ||
    typeof spec.cwd !== "string" ||
    typeof spec.shell !== "string" ||
    typeof spec.outputPath !== "string" ||
    typeof spec.resultPath !== "string"
  ) {
    process.exit(2);
  }

  const jobDir = path.dirname(specPath);
  const runnerPidPath = path.join(jobDir, "runner.pid");
  const childPidPath = path.join(jobDir, "child.pid");
  const killRequestPath = path.join(jobDir, "kill.request");
  const maxLogBytes = Math.min(
    positiveInteger(spec.maxLogBytes, DEFAULT_MAX_LOG_BYTES),
    MAX_LOG_BYTES,
  );

  writePid(runnerPidPath, process.pid);

  let log;
  try {
    fs.mkdirSync(path.dirname(spec.outputPath), {
      recursive: true,
      mode: 0o700,
    });
    log = fs.createWriteStream(spec.outputPath, {
      flags: "w",
      mode: 0o600,
    });
  } catch (error) {
    writeResult(spec.resultPath, {
      jobId,
      status: "failed",
      exitCode: null,
      signal: null,
      timedOut: false,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outputBytes: 0,
      truncated: false,
      error: `Could not open the job log: ${errorMessage(error)}`,
    });
    process.exit(0);
  }

  let writtenBytes = 0;
  let totalBytes = 0;
  let truncated = false;
  let logError = null;
  let paused = false;

  // Stream chunks straight to the log. Past maxLogBytes we keep consuming (so
  // the child never blocks on a full pipe) but discard the excess.
  function onData(chunk) {
    totalBytes += chunk.length;
    if (logError) return;
    if (writtenBytes >= maxLogBytes) {
      truncated = true;
      return;
    }
    const room = maxLogBytes - writtenBytes;
    const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
    if (slice.length < chunk.length) truncated = true;
    writtenBytes += slice.length;
    let ok = true;
    try {
      ok = log.write(slice);
    } catch (error) {
      logError = error;
      return;
    }
    if (!ok && !paused) {
      paused = true;
      child?.stdout?.pause();
      child?.stderr?.pause();
      log.once("drain", () => {
        paused = false;
        child?.stdout?.resume();
        child?.stderr?.resume();
      });
    }
  }

  log.on("error", (error) => {
    logError = error;
  });
  log.on("open", () => {
    try {
      fs.chmodSync(spec.outputPath, 0o600);
    } catch {
      // Windows has no POSIX mode bits.
    }
  });

  const startedAt = new Date().toISOString();
  let child = null;
  let finished = false;
  let stopReason = null;
  let exitCode = null;
  let exitSignal = null;
  let spawnError = null;
  let timeoutTimer = null;
  let killTimer = null;
  let forceTimer = null;

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutTimer);
    clearTimeout(forceTimer);
    clearInterval(killTimer);
    try {
      fs.rmSync(killRequestPath, { force: true });
    } catch {
      // Best effort.
    }

    const status =
      spawnError || stopReason === "timeout"
        ? "failed"
        : stopReason === "killed"
          ? "killed"
          : exitCode === 0
            ? "completed"
            : "failed";

    let error = null;
    if (spawnError) {
      error = `Failed to start the command: ${spawnError}`;
    } else if (stopReason === "timeout") {
      error = `Command timed out after ${positiveInteger(spec.timeoutMs, 0)} ms.`;
    } else if (stopReason === "killed") {
      error = "Command was killed.";
    } else if (status === "failed") {
      error =
        exitSignal !== null
          ? `Command terminated by signal ${exitSignal}.`
          : `Command exited with code ${exitCode}.`;
    }
    if (logError) {
      error = [error, `Log write failed: ${errorMessage(logError)}`]
        .filter(Boolean)
        .join(" ");
    }

    const finalize = () => {
      let outputBytes = writtenBytes;
      try {
        outputBytes = fs.statSync(spec.outputPath).size;
      } catch {
        // Keep the counted value.
      }
      writeResult(spec.resultPath, {
        jobId,
        status,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: exitSignal ?? null,
        timedOut: stopReason === "timeout",
        startedAt,
        finishedAt: new Date().toISOString(),
        outputBytes,
        truncated,
        error,
      });
      process.exit(0);
    };

    if (!log || log.closed) {
      finalize();
      return;
    }
    try {
      log.end(finalize);
    } catch {
      finalize();
    }
  }

  function requestStop(reason) {
    if (finished || stopReason) return;
    stopReason = reason;
    if (child?.pid) {
      void killProcessTree(child.pid, { graceMs: 1500 })
        .catch(() => {})
        .finally(() => {
          // If a wedged child never emits close, still publish a terminal result.
          if (!finished) forceTimer = setTimeout(finish, KILL_GRACE_MS);
        });
    } else {
      finish();
    }
  }

  function watchKillRequest() {
    try {
      if (fs.existsSync(killRequestPath)) {
        requestStop("killed");
      }
    } catch {
      // A transient stat failure must not take the runner down.
    }
  }

  const onSignal = () => requestStop("killed");
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    const isPowershell = /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(
      spec.shell,
    );
    const isCmd = /(?:^|[\\/])cmd(?:\.exe)?$/i.test(spec.shell);
    const spawnOptions = {
      cwd: spec.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    };

    if (isPowershell) {
      child = spawn(
        spec.shell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          spec.command,
        ],
        spawnOptions,
      );
    } else if (isCmd) {
      child = spawn(spec.shell, ["/d", "/s", "/c", spec.command], spawnOptions);
    } else {
      child = spawn(spec.command, [], {
        ...spawnOptions,
        shell: spec.shell,
      });
    }
  } catch (error) {
    spawnError = errorMessage(error);
    finish();
    return;
  }

  if (Number.isInteger(child.pid) && child.pid > 0) {
    writePid(childPidPath, child.pid);
  }

  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.once("error", (error) => {
    spawnError = errorMessage(error);
    if (!child.pid) finish();
  });
  child.once("close", (code, signal) => {
    exitCode = Number.isInteger(code) ? code : null;
    exitSignal = signal ?? null;
    finish();
  });

  timeoutTimer = setTimeout(
    () => requestStop("timeout"),
    positiveInteger(spec.timeoutMs, 30 * 60 * 1000),
  );
  killTimer = setInterval(watchKillRequest, KILL_POLL_MS);
  watchKillRequest();
}

void main().catch(() => {
  process.exit(1);
});
