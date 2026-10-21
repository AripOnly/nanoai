// src/jobs/reconcile.js
//
// Boot-time recovery for detached jobs. The database is only a cache of what
// the job directory says: result.json wins when present. Otherwise the runner
// PID must still exist AND its command line must prove it is the runner for
// this exact job; anything else is "lost", never a fabricated "running".

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { RUNNER_MARKER } from "./spawn.js";
import { isProcessAlive } from "./kill-tree.js";

const execFileAsync = promisify(execFile);
const TERMINAL = new Set(["completed", "failed", "killed", "lost"]);

export async function readResultFile(resultPath) {
  if (typeof resultPath !== "string" || resultPath.trim() === "") return null;
  try {
    const parsed = JSON.parse(await fs.readFile(resultPath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !TERMINAL.has(parsed.status)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readPidFile(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const pid = Number.parseInt(text.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function windowsCommandLine(pid) {
  const query = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
  for (const command of [
    {
      file: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        query,
      ],
    },
    {
      file: "wmic",
      args: ["process", "where", `processid=${pid}`, "get", "commandline", "/value"],
    },
  ]) {
    try {
      const { stdout } = await execFileAsync(command.file, command.args, {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
      const line = String(stdout).trim();
      if (line !== "") {
        return line.replace(/^CommandLine=/, "").trim();
      }
    } catch {
      // Try the next probe.
    }
  }
  return null;
}

async function posixCommandLine(pid) {
  try {
    const raw = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
    const text = raw.replaceAll("\u0000", " ").trim();
    if (text !== "") return text;
  } catch {
    // macOS and other POSIX systems fall through to ps.
  }
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "command="],
      { timeout: 5000, maxBuffer: 64 * 1024 },
    );
    return String(stdout).trim() || null;
  } catch {
    return null;
  }
}

/** The command line of a live process, or null when it cannot be verified. */
export async function processCommandLine(pid) {
  if (!Number.isInteger(pid) || pid < 1 || !isProcessAlive(pid)) {
    return null;
  }
  return process.platform === "win32"
    ? windowsCommandLine(pid)
    : posixCommandLine(pid);
}

export async function verifyRunnerProcess(jobId, pid) {
  if (typeof jobId !== "string" || jobId.trim() === "") return false;
  if (!Number.isInteger(pid) || pid < 1) return false;
  const commandLine = await processCommandLine(pid);
  if (!commandLine) return false;
  return commandLine.includes(RUNNER_MARKER) && commandLine.includes(jobId);
}

/**
 * Decide what a booting gateway should believe about one active job.
 * A terminal result always wins; a live verified runner is running; else lost.
 */
export async function inspectJob(job, { jobDir } = {}) {
  if (!job) {
    return { state: "lost", reason: "Job metadata is missing.", runnerPid: null, childPid: null };
  }
  const dir = jobDir ?? path.dirname(job.result_path ?? job.resultPath ?? "");
  const resultPath = job.result_path ?? job.resultPath;
  const runnerPidPath = path.join(dir, "runner.pid");
  const childPidPath = path.join(dir, "child.pid");

  const result = await readResultFile(resultPath);
  if (result) {
    return { state: "result", result };
  }

  const runnerPid =
    (await readPidFile(runnerPidPath)) ?? job.runner_pid ?? null;
  const childPid = (await readPidFile(childPidPath)) ?? job.child_pid ?? null;

  if (runnerPid && (await verifyRunnerProcess(job.id, runnerPid))) {
    return { state: "running", runnerPid, childPid };
  }

  return {
    state: "lost",
    reason: runnerPid
      ? "The job runner is no longer alive or could not be verified after restart."
      : "The job runner PID was not recorded before the gateway stopped.",
    runnerPid: runnerPid ?? null,
    childPid: childPid ?? null,
  };
}
