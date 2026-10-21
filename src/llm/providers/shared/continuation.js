// src/llm/providers/shared/continuation.js
//
// History produced after a tool batch is provider-neutral. Reasoning signatures
// are NOT added here: the agent loop records them before assistant text so every
// provider sees the same thought -> output -> tool-call order on the next step.

import { EVENT } from "#src/shared/event-type.js";
import { resultText } from "./values.js";

export function toolContinuation({ toolCall, toolResult } = {}) {
  const parts = [];
  if (!Array.isArray(toolCall)) return parts;

  const results = Array.isArray(toolResult) ? toolResult : [];

  for (let i = 0; i < toolCall.length; i++) {
    const call = toolCall[i] ?? {};
    const signature =
      call.signature ??
      call.extra_content?.google?.thought_signature ??
      null;
    parts.push({
      role: EVENT.TOOL_CALL,
      content: {
        type: "tool_call",
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments,
        ...(signature != null ? { signature } : {}),
      },
    });
  }

  for (let i = 0; i < toolCall.length; i++) {
    const call = toolCall[i] ?? {};
    const raw = results[i];
    const attachments = Array.isArray(raw?.attachments)
      ? raw.attachments
      : [];
    parts.push({
      role: EVENT.TOOL_RESULT,
      content: {
        type: "tool_result",
        call_id: call.call_id,
        name: call.name,
        result: resultText(raw),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    });
  }

  return parts;
}
