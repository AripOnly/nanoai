// src/jobs/kill-tree.js
//
// Shared process-tree termination. The detached runner uses it for timeouts
// and explicit kill requests; the gateway uses it only as a fallback when a
// runner no longer responds. Pure Node: no SQLite, settings, or sessions.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Is a pid still present? EPERM means it exists but belongs to another user. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function taskkill(pid) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    let killer;
    try {
      killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      done();
      return;
    }
    killer.once("exit", done);
    killer.once("error", done);
  });
}

/**
 * Kill a process and every descendant. Idempotent: a missing process simply
 * resolves. POSIX expects the target to be a process-group leader (the runner
 * spawns its child detached); a plain pid is used as a fallback.
 */
export async function killProcessTree(pid, { graceMs = 1500 } = {}) {
  if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) {
    return false;
  }

  if (process.platform === "win32") {
    await taskkill(pid);
    return true;
  }

  let signalled = false;
  try {
    process.kill(-pid, "SIGTERM");
    signalled = true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      signalled = true;
    } catch {
      // Already gone.
    }
  }
  if (!signalled) return false;

  await delay(Math.max(0, graceMs));
  if (!isProcessAlive(pid)) return true;

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  return true;
}
