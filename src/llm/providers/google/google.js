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
import { toStr } from "#src/utils/tostr.js";
import { expandAttachments } from "#src/llm/attachment-expansion.js";

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
    return {
      type: "thought",
      signature: part.content.signature,
    };
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

  return null;
}

function errorMessage(err) {
  let message = err?.message;

  if (err?.body) {
    try {
      const data = err.body
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);

      if (data) {
        message = JSON.parse(data).error.message;
      }
    } catch {
      // Keep the original error message.
    }
  }

  const errMsg = String(err?.message ?? err ?? "");
  return message && !errMsg.includes(message)
    ? `${errMsg}\n${message}`
    : message || errMsg || "Google provider error";
}

export function createGoogleProvider() {
  let client = null;
  let clientFingerprint = null;

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

      const next = fingerprint(apiKey, endpoint);
      if (client && clientFingerprint === next) {
        return provider;
      }

      client = new GoogleGenAI({
        apiKey,
        ...(endpoint ? { httpOptions: { baseUrl: endpoint } } : {}),
      });
      clientFingerprint = next;
      return provider;
    },

    async *request(request) {
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
      } catch (err) {
        if (
          err?.name === "AbortError" ||
          err?.code === 20 ||
          err?.message?.includes("aborted")
        ) {
          return;
        }

        yield {
          role: EVENT.ERROR,
          content: {
            code: "PROVIDER_ERROR",
            retryable: false,
            message: errorMessage(err),
          },
        };
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
    },
  };

  return provider;
}

function continuationParts({ reasoningSignature, toolCall, toolResult }) {
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
    const text =
      typeof raw === "string" ? raw : raw?.output ?? raw?.error ?? toStr(raw);
    const attachments = Array.isArray(raw?.attachments)
      ? raw.attachments
      : [];
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
