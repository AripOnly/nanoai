// src/llm/attachment-expansion.js
//
// Provider-neutral attachment bookkeeping. Moved out of
// providers/google/google.js so every provider (google, openai-compatible,
// …) shares one send-exactly-once rule instead of each inventing its own.
//
// History keeps only small attachment references; bytes are loaded from disk
// at send time and marked sent so later turns never pay for them again.
// Storage is infrastructure (src/infra/attachments.js), keeping the provider
// layer free of tool imports.

import { EVENT } from "#src/shared/event-type.js";
import { toStr } from "#src/utils/tostr.js";
import { loadAttachment } from "#src/infra/attachments.js";

/**
 * Collect attachment ids already present in history so they are never
 * re-sent. Called once per agent turn with the pruned conversation input.
 */
export function collectAttachmentIds(input = []) {
  const ids = new Set();
  for (const part of input) {
    const attachments = part?.content?.attachments;
    if (Array.isArray(attachments)) {
      for (const attachment of attachments) {
        if (attachment && typeof attachment.id === "string") ids.add(attachment.id);
      }
    }
    const resultAttachments = part?.content?.result?.attachments;
    if (Array.isArray(resultAttachments)) {
      for (const attachment of resultAttachments) {
        if (attachment && typeof attachment.id === "string") ids.add(attachment.id);
      }
    }
  }
  return ids;
}

/**
 * Expand attachment references into inline bytes for the LLM, exactly once
 * per attachment id. History keeps only the small references; bytes are
 * loaded from disk at send time and marked sent so later turns in the same
 * request never pay for them again.
 */
export async function expandAttachments(input = [], sent = null) {
  const sentIds = sent instanceof Set ? sent : new Set();
  const expanded = [];
  for (const part of input) {
    const attachments = part?.content?.attachments;
    if (part?.role !== EVENT.TOOL_RESULT || !Array.isArray(attachments) || attachments.length === 0) {
      expanded.push(part);
      continue;
    }
    const fresh = attachments.filter(
      (attachment) => attachment && typeof attachment.id === "string" && !sentIds.has(attachment.id),
    );
    if (fresh.length === 0) {
      expanded.push(part);
      continue;
    }
    const subcontents = [{ type: "text", text: toStr(part.content.result) }];
    for (const attachment of fresh) {
      try {
        const bytes = loadAttachment(attachment.id);
        subcontents.push({
          type: "image",
          data: bytes.toString("base64"),
          mime_type: attachment.mime,
        });
        sentIds.add(attachment.id);
      } catch {
        subcontents.push({
          type: "text",
          text: `(Attachment ${attachment.id} expired before it could be sent. Read the file again to re-attach it.)`,
        });
        sentIds.add(attachment.id);
      }
    }
    expanded.push({
      ...part,
      content: { ...part.content, result: subcontents },
    });
  }
  return expanded;
}
