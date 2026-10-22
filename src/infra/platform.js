// src/infra/platform.js
//
// Small, dependency-free platform boundary for process and file-system
// differences. Callers get one implementation on every OS:
// - process-tree termination (taskkill /T on Windows, process groups on POSIX)
// - shell spawn specs for PowerShell, cmd.exe, and POSIX shells
// - owner-only file modes where the platform supports them
//
// Keeping this in one place prevents drift between the job runner, the shell
// tool, and the skills installer.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export function isWindows(platform = process.platform) {
  return platform === "win32";
}

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
 * resolves. POSIX expects the target to be a process-group leader (detached
 * children are spawned that way); a plain pid is used as a fallback.
 */
export async function killProcessTree(
  pid,
  { graceMs = 1500, platform = process.platform } = {},
) {
  if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) {
    return false;
  }

  if (isWindows(platform)) {
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

export function isPowerShell(shell) {
  return /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(String(shell ?? ""));
}

export function isCmd(shell) {
  return /(?:^|[\\/])cmd(?:\.exe)?$/i.test(String(shell ?? ""));
}

/**
 * Build the spawn triple for one shell command. The returned options preserve
 * the project's existing behavior: PowerShell/cmd get their own argument
 * syntax, POSIX commands go through `shell`, and Windows never uses detached
 * process groups (taskkill owns tree cleanup there).
 */
export function buildShellSpawn({
  shell,
  command,
  cwd,
  env,
  detached = !isWindows(),
  executionPolicy = false,
  stdio = ["ignore", "pipe", "pipe"],
} = {}) {
  if (typeof command !== "string" || command.trim() === "") {
    throw new TypeError("buildShellSpawn needs a non-empty command.");
  }

  const base = {
    cwd,
    env,
    stdio,
    windowsHide: true,
    detached,
  };

  if (isPowerShell(shell)) {
    return {
      command: shell,
      args: [
        ...(executionPolicy ? ["-ExecutionPolicy", "Bypass"] : []),
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        command,
      ],
      options: { ...base, detached: false },
    };
  }

  if (isCmd(shell)) {
    return {
      command: shell,
      args: ["/d", "/s", "/c", command],
      options: base,
    };
  }

  return {
    command,
    args: [],
    options: { ...base, shell },
  };
}

/** Apply an owner-only POSIX mode; Windows ACLs are left to the OS default. */
export async function setPrivateMode(
  filePath,
  mode = 0o600,
  { platform = process.platform } = {},
) {
  if (isWindows(platform)) return false;
  try {
    await fs.chmod(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

export function setPrivateModeSync(
  filePath,
  mode = 0o600,
  { platform = process.platform } = {},
) {
  if (isWindows(platform)) return false;
  try {
    fsSync.chmodSync(filePath, mode);
    return true;
  } catch {
    return false;
  }
}
