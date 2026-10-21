// src/llm/providers/shared/values.js
//
// Small provider-neutral value helpers shared by the OpenAI-compatible and
// Anthropic adapters. No SDK imports and no settings access live here.

export function modelId(model) {
  if (model && typeof model === "object") {
    return model.id ?? model.modelId;
  }
  return model;
}

export function parseArguments(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function stringifyArguments(raw) {
  if (typeof raw === "string") return raw;
  return JSON.stringify(raw ?? {});
}

function isSubcontent(value) {
  return (
    value &&
    typeof value === "object" &&
    (value.type === "text" || value.type === "image")
  );
}

export function resultSubcontents(result) {
  return Array.isArray(result) && result.every(isSubcontent) ? result : null;
}

export function resultText(result) {
  if (typeof result === "string") return result;
  const subcontents = resultSubcontents(result);
  if (subcontents) {
    return subcontents
      .filter((part) => part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("\n");
  }
  if (result == null) return "";
  if (typeof result === "object") {
    if (typeof result.output === "string") return result.output;
    if (typeof result.error === "string") return result.error;
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

/** Expanded attachment subcontents as structured image/file descriptors. */
export function resultImages(result) {
  const subcontents = resultSubcontents(result);
  if (!subcontents) return [];
  return subcontents
    .filter(
      (part) =>
        part.type === "image" &&
        typeof part.data === "string" &&
        typeof part.mime_type === "string",
    )
    .map((part) => ({ data: part.data, mime: part.mime_type }));
}

export function dataUrl(mime, data) {
  return `data:${mime};base64,${data}`;
}

export const OPENAI_REASONING_KIND = "nanoai.openai.responses.reasoning";

/**
 * Serialize a completed Responses reasoning item into an opaque signature. The
 * agent loop stores this string and sends it back before assistant text on the
 * next step, which lets stateless (`store: false`) reasoning models continue
 * after a tool call without server-side state.
 */
export function serializeReasoningItem(item) {
  if (!item || item.type !== "reasoning") return null;
  if (typeof item.encrypted_content !== "string" || item.encrypted_content === "") {
    return null;
  }
  const safe = {
    type: "reasoning",
    id: item.id,
    summary: Array.isArray(item.summary) ? item.summary : [],
    encrypted_content: item.encrypted_content,
  };
  if (Array.isArray(item.content)) safe.content = item.content;
  return JSON.stringify({ kind: OPENAI_REASONING_KIND, item: safe });
}

/** Parse a signature created by serializeReasoningItem(). */
export function parseReasoningItem(signature) {
  if (typeof signature !== "string" || !signature.trimStart().startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(signature);
    if (
      parsed?.kind !== OPENAI_REASONING_KIND ||
      parsed.item?.type !== "reasoning" ||
      typeof parsed.item.encrypted_content !== "string"
    ) {
      return null;
    }
    return parsed.item;
  } catch {
    return null;
  }
}
