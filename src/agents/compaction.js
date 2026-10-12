// src/agents/compaction.js

import { llm } from "#src/llm/llm.js";
import { collectAttachmentIds } from "#src/llm/providers/google/google.js";
import { createInstruction } from "#src/prompts/createInstruction.js";
import { EVENT } from "#src/shared/event-type.js";
import { sessionStore } from "#src/session/session-store.js";
import { agents } from "./registry.js";
import { settings } from "#src/config/config.js";

export async function checkCompaction({ provider = null, model, token = null }) {
  const { ratio } = await settings.get("compaction");

  const candidates =
    provider && llm[provider]
      ? llm[provider].models
      : Object.values(llm).flatMap((entry) => entry.models);
  const modelLimit = candidates.find((m) => m.id === model)?.context;

  if (!modelLimit) {
    return false;
  }

  return (token ?? 0) > modelLimit * (ratio / 100);
}

export async function* compaction({ conversation, session_id, provider, model }) {
  const { keep_turn } = await settings.get("compaction");

  // There is nothing to compact if there are not enough turns.
  if (conversation.length <= keep_turn) {
    return null;
  }

  let userIndexes = [];

  let lastCompactionIndex = conversation.findLastIndex(
    (event) => event.role === EVENT.COMPACTION,
  );

  if (lastCompactionIndex === -1) {
    lastCompactionIndex = conversation.length;
  }

  for (let i = 0; i < lastCompactionIndex; i++) {
    if (conversation[i]?.role === EVENT.USER) {
      userIndexes.push(i);
    }
  }

  const keepUserIndexes = userIndexes.slice(-keep_turn);

  if (keepUserIndexes.length < keep_turn) {
    return null;
  }

  const compactConversation = conversation.slice(0, keepUserIndexes[0]);

  const messages = compactConversation.filter(
    (item) =>
      item?.role !== EVENT.COMPACTION &&
      item?.role !== EVENT.ERROR &&
      item?.role !== EVENT.TOOL_UPDATE,
  );

  const oldSummary = sessionStore.getSummary(session_id);
  const compaction = agents["compaction"];
  const request = {
    provider,
    model,
    instruction: await createInstruction(compaction.instruction),
    input: [
      ...(oldSummary
        ? [
            {
              role: EVENT.USER,
              content: {
                text: `Ringkasan sebelumnya:\n${oldSummary}`,
              },
            },
          ]
        : []),

      ...messages,

      {
        role: EVENT.USER,
        content: {
          text: "Buat ringkasan percakapan di atas sekarang.",
        },
      },
    ],

    tools: compaction.tools,
    // The summarizer works from text references only; never re-send bytes.
    sentAttachments: collectAttachmentIds(messages),
  };

  let summary = "";
  for await (const event of llm[provider].request(request)) {
    if (event.role === EVENT.ASSISTANT) {
      summary += event.content?.text ?? "";
    }

    yield event;
  }

  summary = summary.trim();

  if (!summary) {
    throw new Error("Compaction returned an empty summary");
  }

  sessionStore.compact(session_id, summary);
}
