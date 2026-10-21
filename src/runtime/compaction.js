// src/runtime/compaction.js
//
// Compaction is a runtime use-case: it reads the turn-scoped settings snapshot
// and session history, asks the provider for a summary, and persists the
// result through injected callbacks. It does not import settings, the provider
// registry, or the session store, so it can be unit-tested with fakes.

import { EVENT } from "#src/shared/event-type.js";
import { collectAttachmentIds } from "#src/llm/attachment-expansion.js";
import { createInstruction } from "#src/prompts/createInstruction.js";

const COMPACTION_INSTRUCTION = "compaction";

/** Token threshold check used before a turn and between tool steps. */
export function shouldCompact({ token, contextWindow, ratio }) {
  if (!Number.isFinite(token) || token <= 0) return false;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  if (!Number.isFinite(ratio) || ratio <= 0) return false;
  return token > contextWindow * (ratio / 100);
}

function compactableMessages(conversation, keepTurn) {
  if (!Array.isArray(conversation) || conversation.length <= keepTurn) {
    return null;
  }

  let lastCompactionIndex = conversation.findLastIndex(
    (event) => event?.role === EVENT.COMPACTION,
  );
  if (lastCompactionIndex === -1) lastCompactionIndex = conversation.length;

  const userIndexes = [];
  for (let i = 0; i < lastCompactionIndex; i++) {
    if (conversation[i]?.role === EVENT.USER) userIndexes.push(i);
  }

  const keepUserIndexes = userIndexes.slice(-keepTurn);
  if (keepUserIndexes.length < keepTurn) return null;

  const older = conversation.slice(0, keepUserIndexes[0]);
  const messages = older.filter(
    (item) =>
      item?.role !== EVENT.COMPACTION &&
      item?.role !== EVENT.ERROR &&
      item?.role !== EVENT.TOOL_UPDATE,
  );

  return messages.length > 0 ? messages : null;
}

/**
 * Summarize the older part of `conversation`, persist the summary, and yield
 * the provider's raw events as they arrive.
 */
export async function* compactConversation({
  conversation,
  getSummary,
  persistSummary,
  provider, // configured adapter
  model, // model metadata
  signal,
  username,
  keepTurn = 2,
}) {
  const messages = compactableMessages(conversation, keepTurn);
  if (!messages) return;

  const oldSummary =
    typeof getSummary === "function" ? getSummary() : null;

  const instruction = await createInstruction(COMPACTION_INSTRUCTION, {
    username,
  });

  const input = [
    ...(oldSummary
      ? [
          {
            role: EVENT.USER,
            content: { text: `Ringkasan sebelumnya:\n${oldSummary}` },
          },
        ]
      : []),
    ...messages,
    {
      role: EVENT.USER,
      content: { text: "Buat ringkasan percakapan di atas sekarang." },
    },
  ];

  let summary = "";
  for await (const event of provider.request({
    model,
    instruction,
    input,
    tools: [],
    signal,
    sentAttachments: collectAttachmentIds(messages),
  })) {
    if (event?.role === EVENT.ASSISTANT) {
      summary += event.content?.text ?? "";
    }
    yield event;
  }

  summary = summary.trim();
  if (summary === "") {
    throw new Error("Compaction returned an empty summary");
  }

  if (typeof persistSummary !== "function") {
    throw new Error("Compaction requires a persistSummary() callback.");
  }
  persistSummary(summary);
}

/** Build the provider input after a compaction marker, without markers. */
export function prunedInputAfterCompaction({
  pruneConversation,
  conversation,
  summary,
  keepTurn,
}) {
  if (typeof pruneConversation !== "function") {
    throw new Error("prunedInputAfterCompaction requires pruneConversation().");
  }
  const marker = { role: EVENT.COMPACTION, content: { text: summary } };
  const pruned = pruneConversation(
    [...conversation, marker],
    keepTurn,
  );
  return pruned.filter(
    (event) =>
      event?.role !== EVENT.ERROR &&
      event?.role !== EVENT.COMPACTION &&
      event?.role !== EVENT.TOOL_UPDATE,
  );
}
