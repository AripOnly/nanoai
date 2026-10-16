// src/agent/agent.js

import { EVENT } from "#src/shared/event-type.js";
import { getCallId } from "#src/shared/call-id.js";
import { llm } from "#src/llm/llm.js";
import { toolExecute } from "./tool-execute.js";
import { compaction, checkCompaction } from "./compaction.js";
import { sessionStore } from "#src/session/session-store.js";
import { settings } from "#src/config/config.js";

export async function* agentLoop(request) {
  const provider = llm[request.provider];
  if (!provider) {
    throw new Error(`Unknown provider: ${request.provider}`);
  }
  while (true) {
    let toolCall = [];
    let reasoningSignature = "";
    let assistantText = "";
    let token = 0;
    let resultCompaction = "";

    for await (const event of provider.request(request)) {
      switch (event.role) {
        case EVENT.ASSISTANT:
          assistantText += event.content.text;
          break;

        case EVENT.REASONING_SIGNATURE:
          reasoningSignature = event.content.signature;
          break;

        case EVENT.TOOL_CALL:
          toolCall.push({ ...event.content });
          break;

        case EVENT.TOKEN:
          token = event.content.total_tokens;
          break;
      }

      yield event;
    }

    if (assistantText) {
      request.input.push({
        role: EVENT.ASSISTANT,
        content: { text: assistantText },
      });
    }

    if (toolCall.length === 0) break;
    // Dual-channel streaming:
    // - live previews yield TOOL_UPDATE for the user (transient, not persisted)
    // - final values yield TOOL_RESULT for the LLM + history.
    const pendingUpdates = [];
    const promises = toolCall.map((tc) =>
      toolExecute(tc, {
        signal: request.signal,
        sessionID: request.session_id,
        onUpdate: (update = {}) => {
          pendingUpdates.push({
            role: EVENT.TOOL_UPDATE,
            content: {
              call_id: getCallId(update) ?? tc.call_id,
              name: tc.name,
              preview: update.preview ?? "",
            },
          });
        },
        onOutput: (chunk) => {
          const text = chunk?.text ?? "";
          if (!text) return;
          pendingUpdates.push({
            role: EVENT.TOOL_UPDATE,
            content: { call_id: tc.call_id, name: tc.name, preview: text.slice(-4000) },
          });
        },
      }),
    );

    let toolsDone = false;
    const all = Promise.all(promises).then((r) => {
      toolsDone = true;
      return r;
    });
    while (!toolsDone) {
      await Promise.race([all, new Promise((r) => setTimeout(r, 50))]);
      while (pendingUpdates.length > 0) {
        yield pendingUpdates.shift();
      }
    }
    const results = await all;
    while (pendingUpdates.length > 0) {
      yield pendingUpdates.shift();
    }

    for (let i = 0; i < toolCall.length; i++) {
      const callId = getCallId(toolCall[i]) ?? toolCall[i].call_id;
      yield {
        role: EVENT.TOOL_RESULT,
        content: {
          call_id: callId,
          name: toolCall[i].name,
          result: results[i],
          ...(toolCall[i].signature != null
            ? { signature: toolCall[i].signature }
            : {}),
        },
      };
    }

    request.input.push(
      ...provider.feed({
        reasoningSignature,
        toolCall,
        toolResult: results,
      }),
    );

    if (await checkCompaction({ provider: request.provider, model: request.model, token })) {
      let compact = compaction({
        conversation: request.input,
        provider: request.provider,
        model: request.model,
        session_id: request.session_id,
      });

      for await (let event of compact) {
        if (event.role === EVENT.ASSISTANT) {
          resultCompaction += event.content.text;
          yield {
            role: EVENT.COMPACTION,
            content: { text: event.content.text },
          };
        }

        if (event.role === EVENT.ERROR) {
          yield event;
        }
      }

      request.instruction =
        request.instruction + "\n\n" + resultCompaction.trim();

      request.input.push({
        role: EVENT.COMPACTION,
        content: { text: resultCompaction.trim() },
      });
      const { keep_turn } = await settings.get("compaction");
      request.input = sessionStore.pruneConversation(request.input, keep_turn);
    }
  }
}
