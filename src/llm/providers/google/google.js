// src/llm/providers/google/google.js
//
// Google (Gemini) provider adapter. The adapter owns the SDK, the credential
// fingerprint, and the client lifecycle; it never reads settings and never
// exposes a model catalog. Credentials and endpoint arrive through configure()
// from the model resolver, and a rotated key recreates the client because the
// fingerprint changed.

import crypto from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { stream } from "./stream.js";
import { EVENT } from "#src/shared/event-type.js";
import { expandAttachments } from "#src/llm/attachment-expansion.js";
import { providerErrorEvent } from "#src/llm/provider-error.js";
import { toolContinuation } from "#src/llm/providers/shared/continuation.js";
import { GOOGLE_THINKING_KIND } from "./constants.js";

const WIRE = "google-interactions";

function fingerprint(apiKey, endpoint) {
  return crypto
    .createHash("sha256")
    .update(`${apiKey}\n${endpoint ?? ""}`)
    .digest("hex");
}

function modelId(model) {
  if (model && typeof model === "object") {
    return model.id ?? model.modelId;
  }
  return model;
}

function toGemini(part) {
  const role = part.role ?? "text";

  if (
    role === EVENT.TOKEN ||
    role === EVENT.ERROR ||
    role === EVENT.COMPACTION ||
    role === EVENT.TOOL_UPDATE
  ) {
    return null;
  }

  if (role === EVENT.REASONING_SIGNATURE) {
    // Signatures belong to thought steps only. A signature from another
    // provider (OpenAI/Anthropic) must never be sent as a Gemini thought.
    if (
      part.content?.kind != null &&
      part.content.kind !== GOOGLE_THINKING_KIND
    ) {
      return null;
    }
    const summary =
      typeof part.content?.summary === "string" && part.content.summary !== ""
        ? [{ type: "text", text: part.content.summary }]
        : undefined;
    return {
      type: "thought",
      signature: part.content.signature,
      ...(summary ? { summary } : {}),
    };
  }

  if (role === EVENT.TOOL_CALL) {
    // Never attach thought signatures to function calls/results. Gemini
    // requires them as their own thought steps.
    return {
      type: "function_call",
      id: part.content.call_id,
      name: part.content.name,
      arguments: part.content.arguments,
    };
  }

  if (role === EVENT.TOOL_RESULT) {
    return {
      type: "function_result",
      call_id: part.content.call_id,
      name: part.content.name,
      result: part.content.result,
    };
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

  return null;
}

/**
 * Pull the provider's human-readable message out of every body shape the
 * Google SDK has used: an SSE/JSON string, a decoded JSON array, or an object.
 * Newer SDK versions return `[{ error: { message } }]` for HTTP failures.
 */
function messageFromBody(body) {
  if (typeof body === "string") {
    const text = body.trim();
    if (text === "") return null;
    if (text.startsWith("data:")) {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        const nested = messageFromBody(payload);
        if (nested) return nested;
      }
      return null;
    }
    try {
      return messageFromBody(JSON.parse(text));
    } catch {
      return null;
    }
  }

  if (Array.isArray(body)) {
    for (const item of body) {
      const nested = messageFromBody(item);
      if (nested) return nested;
    }
    return null;
  }

  if (body && typeof body === "object") {
    if (
      typeof body.error?.message === "string" &&
      body.error.message.trim() !== ""
    ) {
      return body.error.message.trim();
    }
    if (typeof body.message === "string" && body.message.trim() !== "") {
      return body.message.trim();
    }
    return null;
  }

  return null;
}

function errorMessage(err) {
  let detail = messageFromBody(err?.body);
  if (
    detail === null &&
    typeof err?.error?.message === "string" &&
    err.error.message.trim() !== ""
  ) {
    detail = err.error.message.trim();
  }

  const errMsg = String(err?.message ?? err ?? "");
  const message = detail || errMsg || "Google provider error";
  return errMsg && !errMsg.includes(message)
    ? `${errMsg}\n${message}`
    : message;
}

export function createGoogleProvider({
  clientFactory = (options) => new GoogleGenAI(options),
} = {}) {
  let client = null;
  let clientFingerprint = null;
  let secret = null;

  const provider = {
    id: "google",
    supportedWires: Object.freeze([WIRE]),

    /**
     * Configure the adapter for one credential/endpoint pair. Idempotent:
     * the SDK client is recreated only when the fingerprint changes.
     */
    configure({ credentials, endpoint = null } = {}) {
      const apiKey =
        typeof credentials === "string"
          ? credentials
          : credentials?.apiKey ?? credentials?.api_key;

      if (typeof apiKey !== "string" || apiKey.trim() === "") {
        throw new Error("Google provider requires an API key.");
      }

      const normalizedKey = apiKey.trim();
      const next = fingerprint(normalizedKey, endpoint);
      if (client && clientFingerprint === next) {
        return provider;
      }

      client = clientFactory({
        apiKey: normalizedKey,
        ...(endpoint ? { httpOptions: { baseUrl: endpoint } } : {}),
      });
      clientFingerprint = next;
      secret = normalizedKey;
      return provider;
    },

    async *request(request) {
      if (request?.model?.wire !== WIRE) {
        yield {
          role: EVENT.ERROR,
          content: {
            code: "WIRE_UNSUPPORTED",
            retryable: false,
            message: `Google provider does not support wire "${request?.model?.wire ?? "(missing)"}".`,
          },
        };
        return;
      }

      try {
        if (!client) {
          throw new Error("Google provider is not configured.");
        }

        const input = (
          await expandAttachments(request.input, request.sentAttachments)
        )
          .map(toGemini)
          .filter((part) => part != null);

        const body = {
          model: modelId(request.model),
          input,
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
      } catch (error) {
        const event = providerErrorEvent(error, {
          provider: "google",
          message: errorMessage(error),
          secrets: secret ? [secret] : [],
        });
        if (event) yield event;
      }
    },

    /**
     * Keep provider-specific history parts the adapter needs on the next
     * request. `continue` is the Revisi 2 name; `feed` stays as an alias while
     * older call sites migrate.
     */
    continue(context) {
      return continuationParts(context);
    },

    feed(context) {
      return continuationParts(context);
    },

    dispose() {
      client = null;
      clientFingerprint = null;
      secret = null;
    },
  };

  return provider;
}

function continuationParts(context) {
  // The agent loop owns reasoning-signature placement. This adapter adds only
  // the tool call/result history, exactly once.
  return toolContinuation(context);
}
