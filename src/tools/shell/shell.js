// src/tools/shell/shell.js
// Rebuilt to follow opencode's shell tool rules (read-only reference:
// packages/opencode/src/tool/shell.ts + shell/prompt.ts + core/src/shell.ts).
// Name stays "shell" for nanoai compat, description + JSON schema follow opencode.

import path from "node:path";
import fs from "node:fs";
import { acceptable, name as shellName } from "./select.js";
import { render } from "./prompt.js";
import { analyzeCommand } from "./parse.js";
import { runShell } from "./run.js";
import { limits } from "#src/tools/shared/truncate.js";
import { resolveWorkspaceRoot } from "#src/tools/shared/workspace.js";

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

function resolveCwd(workdir) {
  let root;
  try {
    root = resolveWorkspaceRoot();
  } catch {
    root = process.cwd();
  }
  if (!workdir || String(workdir).trim() === "") {
    return root;
  }
  // Absolute workdir can point anywhere (flexible); relative workdir resolves
  // against the workspace root so results don't depend on launch directory.
  const abs = path.isAbsolute(workdir) ? path.normalize(workdir) : path.resolve(root, workdir);
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st?.isDirectory()) {
    throw new Error(`workdir does not exist or is not a directory: ${workdir}`);
  }
  return abs;
}

export async function shell(params, context = {}) {
  const command = params?.command;
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("Command must be a non-empty string.");
  }
  if (params?.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout < 0)) {
    throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`);
  }

  const shellPath = currentShell();
  const cwd = resolveCwd(params?.workdir);
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
    output: result.output,
    exitCode: result.code,
    cwd,
    timedOut: result.timedOut,
    aborted: result.aborted,
    truncated: result.truncated,
    ...(result.outputPath ? { outputPath: result.outputPath } : {}),
  };
}
