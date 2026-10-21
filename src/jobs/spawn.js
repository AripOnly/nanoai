// src/jobs/spawn.js
//
// Gateway-side filesystem and process handshake for a detached job runner.
// The runner itself never imports this module; the contract between the two is
// the job directory: spec.json in, result.json/log/pid files out.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "#src/infra/secure-file.js";

export const RUNNER_MARKER = "nanoai-job-runner";
export const RUNNER_PATH = fileURLToPath(new URL("./runner.js", import.meta.url));

export function jobPaths(jobDir) {
  return {
    dir: jobDir,
    spec: path.join(jobDir, "spec.json"),
    output: path.join(jobDir, "output.log"),
    result: path.join(jobDir, "result.json"),
    runnerPid: path.join(jobDir, "runner.pid"),
    childPid: path.join(jobDir, "child.pid"),
    killRequest: path.join(jobDir, "kill.request"),
  };
}

export async function ensureJobDir(jobDir) {
  await fs.mkdir(jobDir, { recursive: true, mode: 0o700 });
  return jobPaths(jobDir);
}

/** spec.json is owner-only and replaced atomically before the runner starts. */
export async function writeJobSpec(specPath, spec) {
  await writeFileAtomic(specPath, `${JSON.stringify(spec, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * Start the detached runner. The marker and job id stay on its command line so
 * boot reconciliation can prove the PID it found really belongs to this job.
 */
export function spawnRunner({ jobId, specPath, runnerPath = RUNNER_PATH }) {
  if (typeof jobId !== "string" || jobId.trim() === "") {
    throw new Error("jobId is required to spawn a job runner.");
  }
  const child = spawn(
    process.execPath,
    [
      runnerPath,
      "--tag",
      RUNNER_MARKER,
      "--job-id",
      jobId,
      "--spec",
      specPath,
    ],
    {
      cwd: path.dirname(specPath),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    },
  );
  if (!Number.isInteger(child.pid) || child.pid < 1) {
    throw new Error("Failed to start the background job runner.");
  }
  child.unref();
  return child.pid;
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

/** Wait briefly for the runner's first handshake (runner.pid). */
export async function waitForPidFile(filePath, timeoutMs = 1200, intervalMs = 40) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    const pid = await readPidFile(filePath);
    if (pid) return pid;
    await delay(intervalMs);
  }
  return null;
}

/** Ask a live runner to take its idempotent kill path. */
export async function requestKill(jobDir) {
  const { killRequest } = jobPaths(jobDir);
  await writeFileAtomic(killRequest, `${JSON.stringify({ at: new Date().toISOString() })}\n`, {
    mode: 0o600,
  });
  return killRequest;
}

export async function clearKillRequest(jobDir) {
  try {
    await fs.rm(jobPaths(jobDir).killRequest, { force: true });
  } catch {
    // Best effort.
  }
}

/** Fallback path when a runner is dead or unresponsive; same JSON contract. */
export async function writeResultFile(resultPath, result) {
  const directory = path.dirname(resultPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    directory,
    `.result.json.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tempPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, resultPath);
  try {
    await fs.chmod(resultPath, 0o600);
  } catch {
    // Windows has no POSIX mode bits.
  }
  return resultPath;
}
