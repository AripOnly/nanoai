// src/tools/executor.js
//
// The single dispatch point for model-requested tools. The agent loop always
// passes the agent's allowlist and policy envelope; the executor enforces both
// before any tool code runs, so a model cannot escape a read-only agent by
// inventing a shell call.

import { toolRegistry } from "./registry.js";
import { WRITE_TOOLS } from "./contract.js";

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

function isAllowed(allowedTools, name) {
  if (allowedTools == null) return true;
  if (typeof allowedTools.has === "function") return allowedTools.has(name);
  if (Array.isArray(allowedTools)) return allowedTools.includes(name);
  return false;
}

function denied(name, reason) {
  return { success: false, error: `Tool "${name}" ${reason}` };
}

function policyDenies(definition, policy = {}) {
  const capabilities = definition.capabilities ?? {};

  if (
    capabilities.shell === true &&
    (policy.allowShell === false || policy.allowWrite === false)
  ) {
    return "is disabled by the agent policy.";
  }

  if (WRITE_TOOLS.includes(definition.name) && policy.allowWrite === false) {
    return "is disabled by the agent policy.";
  }

  if (capabilities.net === true && policy.net === false) {
    return "is disabled by the agent policy.";
  }

  return null;
}

export function withTimeout(promise, timeoutMs, name) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({
        success: false,
        error: `Tool "${name}" timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function executeTool(tool, context = {}) {
  const { name, arguments: rawArgument, call_id, callId } = tool ?? {};

  const definition = toolRegistry.get(name);
  if (!definition) {
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

  const policyError = policyDenies(definition, context.policy);
  if (policyError) {
    return denied(name, policyError);
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

    const result = await withTimeout(
      definition.execute(args, mergedContext),
      mergedContext.timeoutMs ??
        definition.timeoutMs ??
        DEFAULT_TOOL_TIMEOUT_MS,
      name,
    );

    if (result === undefined) {
      return { success: false, error: `Tool "${name}" returned no result.` };
    }

    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Backwards-compatible name used by older call sites and tests. */
export const toolExecute = executeTool;
