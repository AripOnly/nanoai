// src/llm/providers/anthropic/anthropic.js
//
// Anthropic Messages adapter. The adapter owns the SDK and client lifecycle;
// it turns neutral history into Messages blocks, including thinking signatures
// and tool results with image/PDF content, and normalizes the SSE stream.

import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { EVENT } from "#src/shared/event-type.js";
import { expandAttachments } from "#src/llm/attachment-expansion.js";
import { providerErrorEvent } from "#src/llm/provider-error.js";
import { toolContinuation } from "#src/llm/providers/shared/continuation.js";
import {
  modelId,
  parseArguments,
  resultSubcontents,
  resultText,
} from "#src/llm/providers/shared/values.js";

const WIRE = "anthropic-messages";
const THINKING_KIND = "anthropic-thinking";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function fingerprint(apiKey, endpoint) {
  return crypto
    .createHash("sha256")
    .update(`${apiKey}\n${endpoint ?? ""}`)
    .digest("hex");
}

function apiKeyOf(credentials) {
  return typeof credentials === "string"
    ? credentials
    : credentials?.apiKey ?? credentials?.api_key;
}

function textPart(part) {
  return String(part?.content?.text ?? "");
}

function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.parameters ?? { type: "object", properties: {} },
  }));
}

function thinkingBlock(content) {
  if (content?.kind !== THINKING_KIND) return null;
  if (typeof content.signature !== "string" || content.signature === "") {
    return null;
  }
  if (content.redacted === true) {
    return { type: "redacted_thinking", data: content.signature };
  }
  return {
    type: "thinking",
    thinking: typeof content.summary === "string" ? content.summary : "",
    signature: content.signature,
  };
}

function toolResultBlock(content) {
  const subcontents = resultSubcontents(content?.result);
  if (!subcontents) {
    return {
      type: "tool_result",
      tool_use_id: content?.call_id,
      content: resultText(content?.result),
    };
  }

  const blocks = [];
  for (const part of subcontents) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: String(part.text ?? "") });
      continue;
    }
    if (part.type !== "image" || typeof part.data !== "string") continue;

    const mime = part.mime_type ?? "image/png";
    if (mime === "application/pdf") {
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: part.data,
        },
      });
    } else if (IMAGE_TYPES.has(mime)) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mime, data: part.data },
      });
    } else {
      blocks.push({
        type: "text",
        text: `(Unsupported attachment type: ${mime})`,
      });
    }
  }

  return {
    type: "tool_result",
    tool_use_id: content?.call_id,
    content: blocks.length > 0 ? blocks : resultText(content?.result),
  };
}

/** Convert neutral history to Anthropic Messages content blocks. */
export function toAnthropicMessages(input = []) {
  const messages = [];
  let assistant = null;
  let toolResults = null;

  function reset() {
    assistant = null;
    toolResults = null;
  }

  function ensureAssistant() {
    if (assistant) return assistant;
    toolResults = null;
    assistant = { role: "assistant", content: [] };
    messages.push(assistant);
    return assistant;
  }

  function ensureToolResults() {
    assistant = null;
    if (toolResults) return toolResults;
    toolResults = { role: "user", content: [] };
    messages.push(toolResults);
    return toolResults;
  }

  for (const part of input) {
    switch (part?.role) {
      case EVENT.USER:
        reset();
        messages.push({
          role: "user",
          content: [{ type: "text", text: textPart(part) }],
        });
        break;

      case EVENT.REASONING_SIGNATURE: {
        const block = thinkingBlock(part.content);
        if (block) ensureAssistant().content.push(block);
        break;
      }

      case EVENT.ASSISTANT: {
        const text = textPart(part);
        if (text === "") break;
        ensureAssistant().content.push({ type: "text", text });
        break;
      }

      case EVENT.TOOL_CALL: {
        const content = part.content ?? {};
        ensureAssistant().content.push({
          type: "tool_use",
          id: content.call_id,
          name: content.name,
          input: parseArguments(content.arguments),
        });
        break;
      }

      case EVENT.TOOL_RESULT:
        ensureToolResults().content.push(toolResultBlock(part.content));
        break;

      default:
        break;
    }
  }

  return messages.filter(
    (message) => Array.isArray(message.content) && message.content.length > 0,
  );
}

function usageEvent(usage) {
  if (!usage) return null;
  return {
    role: EVENT.TOKEN,
    content: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      total_tokens:
        usage.total_tokens ??
        (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      cached_tokens:
        usage.cache_read_input_tokens ??
        usage.input_tokens_details?.cached_tokens ??
        null,
      reasoning_tokens:
        usage.output_tokens_details?.reasoning_tokens ?? null,
    },
  };
}

async function* requestAnthropic({ client, request, input }) {
  const body = {
    model: modelId(request.model),
    max_tokens: request.model?.maxOutputTokens ?? 8192,
    messages: toAnthropicMessages(input),
    stream: true,
  };
  if (typeof request.instruction === "string" && request.instruction.trim() !== "") {
    body.system = request.instruction;
  }
  const tools = toAnthropicTools(request.tools);
  if (tools) body.tools = tools;
  if (request.model?.capabilities?.reasoning === true) {
    body.thinking = { type: "adaptive", display: "summarized" };
  }

  const stream = await client.messages.create(body, {
    signal: request.signal,
  });

  const blocks = new Map();
  let usage = null;

  for await (const event of stream) {
    switch (event?.type) {
      case "message_start":
        usage = event.message?.usage ?? usage;
        break;

      case "content_block_start": {
        const block = event.content_block;
        if (!block) break;
        blocks.set(event.index, {
          type: block.type,
          id: block.id ?? null,
          name: block.name ?? null,
          input: "",
          thinking: typeof block.thinking === "string" ? block.thinking : "",
          signature:
            typeof block.signature === "string" ? block.signature : "",
          redacted: block.type === "redacted_thinking" ? block.data ?? "" : "",
        });
        if (block.type === "redacted_thinking" && block.data) {
          yield {
            role: EVENT.REASONING_SIGNATURE,
            content: {
              kind: THINKING_KIND,
              redacted: true,
              signature: block.data,
              summary: "",
            },
          };
        }
        break;
      }

      case "content_block_delta": {
        const block = blocks.get(event.index);
        const delta = event.delta;
        if (!block || !delta) break;

        if (delta.type === "text_delta") {
          if (delta.text !== "") {
            yield { role: EVENT.ASSISTANT, content: { text: delta.text } };
          }
        } else if (delta.type === "thinking_delta") {
          if (delta.thinking !== "") {
            block.thinking += delta.thinking;
            yield {
              role: EVENT.REASONING_SUMMARY,
              content: { text: delta.thinking },
            };
          }
        } else if (delta.type === "signature_delta") {
          block.signature += delta.signature ?? "";
        } else if (delta.type === "input_json_delta") {
          block.input += delta.partial_json ?? "";
        }
        break;
      }

      case "content_block_stop": {
        const block = blocks.get(event.index);
        if (!block) break;
        blocks.delete(event.index);

        if (block.type === "thinking" && block.signature !== "") {
          yield {
            role: EVENT.REASONING_SIGNATURE,
            content: {
              kind: THINKING_KIND,
              signature: block.signature,
              summary: block.thinking,
            },
          };
        } else if (block.type === "tool_use") {
          yield {
            role: EVENT.TOOL_CALL,
            content: {
              call_id: block.id,
              name: block.name,
              arguments: parseArguments(block.input),
            },
          };
        }
        break;
      }

      case "message_delta":
        if (event.usage) {
          usage = {
            ...(usage ?? {}),
            ...event.usage,
            input_tokens: usage?.input_tokens ?? event.usage.input_tokens ?? 0,
            output_tokens: event.usage.output_tokens ?? usage?.output_tokens ?? 0,
          };
        }
        break;

      case "error":
        throw new Error(event.error?.message ?? "Anthropic stream error.");

      default:
        break;
    }
  }

  const token = usageEvent(usage);
  if (token) yield token;
}

export function createAnthropicProvider({
  clientFactory = (options) => new Anthropic(options),
} = {}) {
  let client = null;
  let clientFingerprint = null;
  let secret = null;

  const provider = {
    id: "anthropic",
    supportedWires: Object.freeze([WIRE]),

    configure({ credentials, endpoint = null } = {}) {
      const apiKey = apiKeyOf(credentials);
      if (typeof apiKey !== "string" || apiKey.trim() === "") {
        throw new Error("Anthropic provider requires an API key.");
      }

      const baseURL = endpoint || ANTHROPIC_BASE_URL;
      const next = fingerprint(apiKey.trim(), baseURL);
      if (client && clientFingerprint === next) return provider;

      client = clientFactory({
        apiKey: apiKey.trim(),
        baseURL,
      });
      clientFingerprint = next;
      secret = apiKey.trim();
      return provider;
    },

    async *request(request) {
      if (request?.model?.wire !== WIRE) {
        yield {
          role: EVENT.ERROR,
          content: {
            code: "WIRE_UNSUPPORTED",
            retryable: false,
            message: `Anthropic provider does not support wire "${request?.model?.wire ?? "(missing)"}".`,
          },
        };
        return;
      }

      try {
        if (!client) {
          throw new Error("Anthropic provider is not configured.");
        }
        const input = await expandAttachments(
          request.input,
          request.sentAttachments,
        );
        yield* requestAnthropic({ client, request, input });
      } catch (error) {
        const event = providerErrorEvent(error, {
          provider: "anthropic",
          secrets: secret ? [secret] : [],
        });
        if (event) yield event;
      }
    },

    continue(context) {
      return toolContinuation(context);
    },

    feed(context) {
      return toolContinuation(context);
    },

    dispose() {
      client = null;
      clientFingerprint = null;
      secret = null;
    },
  };

  return provider;
}
