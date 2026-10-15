import { GoogleGenAI } from "@google/genai";
import "dotenv/config";
import { stream } from "./stream.js";
import { EVENT } from "#src/shared/event-type.js";
import { settings } from "#src/config/config.js";
import { toStr } from "#src/utils/tostr.js";
import { loadAttachment } from "#src/tools/shared/attachments.js";

async function getClient() {
  // Built per request on purpose: no cached credentials, so a rotated API
  // key takes effect immediately without restarting the gateway.
  let providerKeys = {};
  try {
    const stored = await settings.get("provider_keys");
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      providerKeys = stored;
    }
  } catch {
    providerKeys = {};
  }

  // Per-provider keys take precedence; the legacy top-level api_key stays
  // as a fallback so existing setups keep working.
  const apiKey =
    (typeof providerKeys.google === "string" && providerKeys.google) ||
    (await settings.get("api_key"));
  if (!apiKey) {
    throw new Error("API key not configured. Run setup first.");
  }
  return new GoogleGenAI({ apiKey });
}

function toGemini(part) {
  const role = part.role ?? "text";

  if (role === EVENT.TOKEN || role === EVENT.ERROR || role === EVENT.COMPACTION || role === EVENT.TOOL_UPDATE)
    return null;

  if (role === EVENT.REASONING_SIGNATURE) {
    const thought = {
      type: "thought",
      signature: part.content.signature,
    };

    return thought;
  }

  if (role === EVENT.TOOL_CALL) {
    const functionCall = {
      type: "function_call",
      id: part.content.call_id,
      name: part.content.name,
      arguments: part.content.arguments,
    };

    if (part.content.signature != null) {
      functionCall.signature = part.content.signature;
    }

    return functionCall;
  }

  if (role === EVENT.TOOL_RESULT) {
    const functionResult = {
      type: "function_result",
      call_id: part.content.call_id,
      name: part.content.name,
      result: part.content.result,
    };

    if (part.content.signature != null) {
      functionResult.signature = part.content.signature;
    }

    return functionResult;
  }

  if (role === EVENT.ASSISTANT) {
    return {
      type: "model_output",
      content: [{ type: "text", text: part.content.text }],
    };
  }

  if (role === EVENT.USER) {
    return {
      type: "user_input",
      content: [{ type: "text", text: part.content.text }],
    };
  }
}

export async function* request(request) {
  try {
    const client = await getClient();

    const input = (await expandAttachments(request.input, request.sentAttachments))
      .map(toGemini)
      .filter((part) => part != null);

    const body = {
      model: request.model,
      input: input,
      system_instruction: request.instruction,
      tools: request.tools,
      store: false,
      stream: true,
      generation_config: {
        temperature: 1.0,
        thinking_summaries: "auto",
      },
    };

    const llmStream = await client.interactions.create(body, {
      fetchOptions: { signal: request.signal },
    });

    yield* stream(llmStream);
  } catch (err) {
    if (
      err.name === "AbortError" ||
      err.code === 20 ||
      err.message?.includes("aborted")
    ) {
      return;
    }
    let message = err.message;

    if (err.body) {
      try {
        const data = err.body
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);

        if (data) {
          message = JSON.parse(data).error.message;
        }
      } catch {
        err.message;
      }
    }

    const errMsg = String(err?.message ?? err ?? "");
    const formatted =
      message && !errMsg.includes(message)
        ? `${errMsg}\n${message}`
        : (message || errMsg || "Google provider error");

    yield {
      role: EVENT.ERROR,
      content: {
        message: formatted,
      },
    };
  }
}

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

export function feed({ reasoningSignature, toolCall, toolResult }) {
  const parts = [];

  if (reasoningSignature) {
    parts.push({
      role: EVENT.REASONING_SIGNATURE,
      content: { signature: reasoningSignature },
    });
  }

  if (!toolCall) {
    return parts;
  }

  for (let i = 0; i < toolCall.length; i++) {
    const functionCall = {
      role: EVENT.TOOL_CALL,
      content: {
        type: "tool_call",
        call_id: toolCall[i].call_id,
        name: toolCall[i].name,
        arguments: toolCall[i].arguments,
      },
    };

    if (toolCall[i].signature != null) {
      functionCall.content.signature = toolCall[i].signature;
    }

    parts.push(functionCall);
  }

  for (let i = 0; i < toolCall.length; i++) {
    // Raw tool results stay structured here: readable text goes to `result`,
    // attachment references ride alongside and are expanded to bytes exactly
    // once at send time (see expandAttachments).
    const raw = toolResult[i];
    const text = typeof raw === "string" ? raw : (raw?.output ?? raw?.error ?? toStr(raw));
    const attachments = Array.isArray(raw?.attachments) ? raw.attachments : [];
    const functionResult = {
      role: EVENT.TOOL_RESULT,
      content: {
        type: "tool_result",
        call_id: toolCall[i].call_id,
        name: toolCall[i].name,
        result: text,
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    };

    if (toolCall[i].signature != null) {
      functionResult.content.signature = toolCall[i].signature;
    }

    parts.push(functionResult);
  }

  return parts;
}
