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
import {
  assertBackgroundAllowed,
  normalizeNotify,
} from "#src/jobs/policy.js";
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
  if (
    params?.background !== undefined &&
    typeof params.background !== "boolean"
  ) {
    return fail("Parameter 'background' must be a boolean.");
  }
  if (params?.name !== undefined && typeof params.name !== "string") {
    return fail("Parameter 'name' must be a string.");
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

  if (params?.background === true) {
    try {
      assertBackgroundAllowed(context.policy);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (!context.jobs || typeof context.jobs.create !== "function") {
      return fail("Background jobs are not available in this runtime.");
    }
    if (!context.sessionID && !context.session_id) {
      return fail("Background jobs require an active session.");
    }
    let notify;
    try {
      notify =
        params?.notify === undefined || params?.notify === null
          ? undefined
          : normalizeNotify(params.notify);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    try {
      const job = await context.jobs.create({
        sessionId: context.sessionID ?? context.session_id,
        command,
        cwd,
        shell: shellPath,
        name: params?.name,
        notify,
        timeoutMs: params?.timeout,
      });
      return {
        success: true,
        output: `Background job ${job.jobId} started (status: ${job.status}). Use the process tool to poll it; do not sleep in this turn.`,
        jobId: job.jobId,
        status: job.status,
        pid: job.runnerPid,
        logPath: job.logPath,
        startedAt: job.startedAt,
        pollAfterMs: job.pollAfterMs,
        background: true,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error?.code ? { code: error.code } : {}),
      };
    }
  }

  if (params?.notify !== undefined || params?.name !== undefined) {
    return fail(
      "Parameters 'name' and 'notify' only apply when background is true.",
    );
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
