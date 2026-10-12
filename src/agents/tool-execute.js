// src/agents/tool-execute.js

import { tools } from "#src/tools/tools.js";

export async function toolExecute(tool, context = {}) {
  const { name, arguments: rawArgument, call_id, callId } = tool;

  if (!(name in tools)) {
    return {
      success: false,
      error: `Tool "${name}" not found.`,
    };
  }

  const mergedContext = { ...context };
  const resolvedCallId = mergedContext.callId ?? mergedContext.call_id ?? callId ?? call_id;
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
