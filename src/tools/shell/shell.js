// src/tools/shell/shell.js
// Shell tool: streaming execution with timeouts, previews, and a safety net.
// Name stays "shell" for nanoai compat.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { acceptable, name as shellName } from "./select.js";
import { render } from "./prompt.js";
import { analyzeCommand } from "./parse.js";
import { runShell } from "./run.js";
import { fail, limits, assertInsideWorkspace, resolveWorkspaceRoot } from "#src/tools/shared/index.js";

export const DEFAULT_TIMEOUT_MS = 120_000;

function currentShell() {
  try {
    return acceptable();
  } catch {
    return process.platform === "win32" ? "powershell.exe" : "bash";
  }
}

function buildSchema() {
  const shell = currentShell();
  const shellKind = shellName(shell) || (process.platform === "win32" ? "powershell" : "bash");
  const { description, parameters } = render(shellKind, process.platform, limits(), DEFAULT_TIMEOUT_MS);
  return {
    type: "function",
    name: "shell",
    description,
    parameters,
  };
}

export const shellTool = buildSchema();

// Throws a plain Error; shell() converts it into a fail() result so every
// failure leaves through the same envelope.
function resolveCwd(workdir, policy = {}) {
  const confined = policy?.allowOutsideRoot === false;
  const base = confined ? resolveWorkspaceRoot() : os.homedir();
  if (!workdir || String(workdir).trim() === "") {
    return base;
  }
  // Absolute workdir can point anywhere (flexible); a confined policy checks
  // containment. Relative workdir resolves against the home directory unless
  // the policy confines the agent to its workspace.
  const abs = path.isAbsolute(workdir)
    ? path.normalize(workdir)
    : path.resolve(base, workdir);
  assertInsideWorkspace(abs, policy);
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st?.isDirectory()) {
    throw new Error(`workdir does not exist or is not a directory: ${workdir}`);
  }
  return abs;
}

export async function shell(params, context = {}) {
  if (
    context.policy?.allowShell === false ||
    context.policy?.allowWrite === false
  ) {
    return fail('Tool "shell" is disabled by the agent policy.');
  }

  const command = params?.command;
  if (typeof command !== "string" || command.trim() === "") {
    return fail("Parameter 'command' must be a non-empty string.");
  }
  if (
    params?.timeout !== undefined &&
    (!Number.isFinite(params.timeout) || params.timeout < 0)
  ) {
    return fail(
      `Parameter 'timeout' must be a non-negative number of milliseconds. Got: ${params.timeout}.`,
    );
  }

  let cwd;
  try {
    cwd = resolveCwd(params?.workdir, context.policy);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const shellPath = currentShell();
  const timeout = params?.timeout ?? DEFAULT_TIMEOUT_MS;

  const analysis = analyzeCommand(command, cwd, shellPath);
  if (analysis.blocked) {
    return {
      success: false,
      output: "",
      exitCode: null,
      timedOut: false,
      aborted: false,
      truncated: false,
      blocked: true,
      error:
        `Blocked by safety policy: ${analysis.blocked}. ` +
        "Do not retry this command. Explain to the user what was blocked " +
        "and why, then propose a safer alternative.",
    };
  }

  const callId = context.callId ?? context.call_id ?? undefined;
  const onUpdate = (update) => {
    try {
      context.onUpdate?.({ call_id: callId, preview: update.preview });
    } catch {
      // never break execution
    }
    try {
      context.onOutput?.({ type: "stdout", text: update.preview });
    } catch {
      // ignore
    }
  };

  const result = await runShell({
    shell: shellPath,
    command,
    cwd,
    env: process.env,
    timeout,
    signal: context.signal,
    onUpdate,
  });

  return {
    success: true,
    output: result.output,
    exitCode: result.code,
    cwd,
    timedOut: result.timedOut,
    aborted: result.aborted,
    truncated: result.truncated,
    ...(result.outputPath ? { outputPath: result.outputPath } : {}),
  };
}
