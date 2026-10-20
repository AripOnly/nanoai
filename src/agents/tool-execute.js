// src/agents/tool-execute.js
//
// The single dispatch point for model-requested tools. The agent loop always
// passes the agent's allowlist and policy envelope; toolExecute enforces both
// before any tool code runs, so a model cannot escape a read-only agent by
// inventing a shell call.

import { tools } from "#src/tools/tools.js";

const WRITE_TOOLS = new Set(["write", "writeWord", "writeExcel", "edit"]);

function isAllowed(allowedTools, name) {
  if (allowedTools == null) return true;
  if (typeof allowedTools.has === "function") return allowedTools.has(name);
  if (Array.isArray(allowedTools)) return allowedTools.includes(name);
  return false;
}

function denied(name, reason) {
  return { success: false, error: `Tool "${name}" ${reason}` };
}

export async function toolExecute(tool, context = {}) {
  const { name, arguments: rawArgument, call_id, callId } = tool ?? {};

  if (typeof name !== "string" || !(name in tools)) {
    return {
      success: false,
      error: `Tool "${name}" not found.`,
    };
  }

  if (context.signal?.aborted) {
    return denied(name, "was aborted before it started.");
  }

  if (!isAllowed(context.allowedTools, name)) {
    return denied(name, "is not allowed for this agent.");
  }

  const policy = context.policy ?? {};
  if (
    name === "shell" &&
    (policy.allowShell === false || policy.allowWrite === false)
  ) {
    return denied(name, "is disabled by the agent policy.");
  }
  if (WRITE_TOOLS.has(name) && policy.allowWrite === false) {
    return denied(name, "is disabled by the agent policy.");
  }

  const mergedContext = { ...context };
  const resolvedCallId =
    mergedContext.callId ?? mergedContext.call_id ?? callId ?? call_id;
  if (resolvedCallId !== undefined) {
    mergedContext.callId ??= resolvedCallId;
    mergedContext.call_id ??= resolvedCallId;
  }

  try {
    let args;
    try {
      args =
        typeof rawArgument === "string" ? JSON.parse(rawArgument) : rawArgument;
    } catch {
      throw new Error(
        `Tool "${name}" received invalid arguments: must be valid JSON.`,
      );
    }

    return await tools[name](args, mergedContext);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
