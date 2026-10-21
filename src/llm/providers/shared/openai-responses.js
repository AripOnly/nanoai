// src/llm/providers/shared/openai-responses.js
//
// OpenAI Responses wire. NanoAI keeps the conversation itself, so requests are
// always sent with store:false. Reasoning items are round-tripped through the
// opaque signature channel using their encrypted_content payload.

import { EVENT } from "#src/shared/event-type.js";
import {
  OPENAI_REASONING_KIND,
  dataUrl,
  modelId,
  parseArguments,
  parseReasoningItem,
  resultSubcontents,
  resultText,
  serializeReasoningItem,
  stringifyArguments,
} from "./values.js";

function textPart(part) {
  return String(part?.content?.text ?? "");
}

function toResponsesTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? { type: "object", properties: {} },
  }));
}

function responseOutput(result) {
  const text = resultText(result);
  if (!resultSubcontents(result)) return text;

  const content = [];
  for (const part of result) {
    if (part.type === "text") {
      content.push({ type: "input_text", text: String(part.text ?? "") });
      continue;
    }
    if (part.type === "image" && typeof part.data === "string") {
      const mime = part.mime_type ?? "image/png";
      if (!mime.startsWith("image/")) {
        content.push({
          type: "input_text",
          text: `(Unsupported attachment type: ${mime})`,
        });
        continue;
      }
      content.push({
        type: "input_image",
        image_url: dataUrl(mime, part.data),
        detail: "auto",
      });
    }
  }
  return content.length > 0 ? content : text;
}

/** Convert neutral history to Responses input items. */
export function toResponsesInput(input = []) {
  const items = [];

  for (const part of input) {
    switch (part?.role) {
      case EVENT.USER: {
        const text = textPart(part);
        if (text !== "") items.push({ role: "user", content: text });
        break;
      }

      case EVENT.ASSISTANT: {
        const text = textPart(part);
        if (text !== "") items.push({ role: "assistant", content: text });
        break;
      }

      case EVENT.REASONING_SIGNATURE: {
        const item = parseReasoningItem(part.content?.signature);
        if (item) items.push(item);
        break;
      }

      case EVENT.TOOL_CALL: {
        const content = part.content ?? {};
        items.push({
          type: "function_call",
          call_id: content.call_id,
          name: content.name,
          arguments: stringifyArguments(content.arguments),
        });
        break;
      }

      case EVENT.TOOL_RESULT: {
        const content = part.content ?? {};
        items.push({
          type: "function_call_output",
          call_id: content.call_id,
          output: responseOutput(content.result),
        });
        break;
      }

      default:
        break;
    }
  }

  return items;
}

function reasoningText(item) {
  if (!Array.isArray(item?.summary)) return "";
  return item.summary
    .map((entry) => entry?.text ?? "")
    .filter((text) => typeof text === "string" && text !== "")
    .join("\n");
}

/**
 * Stream one Responses request. Uses output_item.done for tool calls and
 * reasoning items because those are the only complete payloads.
 */
export async function* requestResponses({ client, request, input }) {
  const reasoning = request.model?.capabilities?.reasoning === true;
  const body = {
    model: modelId(request.model),
    input: toResponsesInput(input),
    store: false,
    stream: true,
  };
  if (typeof request.instruction === "string" && request.instruction.trim() !== "") {
    body.instructions = request.instruction;
  }
  const tools = toResponsesTools(request.tools);
  if (tools) body.tools = tools;
  if (reasoning) {
    body.include = ["reasoning.encrypted_content"];
    body.reasoning = { summary: "auto" };
  }

  const stream = await client.responses.create(body, {
    signal: request.signal,
  });

  const emittedReasoning = new Set();
  let sawReasoningSummary = false;
  let sawText = false;
  let usage = null;

  for await (const event of stream) {
    switch (event?.type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string" && event.delta !== "") {
          sawText = true;
          yield { role: EVENT.ASSISTANT, content: { text: event.delta } };
        }
        break;

      case "response.refusal.delta":
        if (typeof event.delta === "string" && event.delta !== "") {
          sawText = true;
          yield { role: EVENT.ASSISTANT, content: { text: event.delta } };
        }
        break;

      case "response.reasoning_summary_text.delta":
        if (typeof event.delta === "string" && event.delta !== "") {
          sawReasoningSummary = true;
          yield {
            role: EVENT.REASONING_SUMMARY,
            content: { text: event.delta },
          };
        }
        break;

      case "response.output_item.done": {
        const item = event.item;
        if (!item) break;

        if (item.type === "function_call") {
          yield {
            role: EVENT.TOOL_CALL,
            content: {
              call_id: item.call_id,
              name: item.name,
              arguments: parseArguments(item.arguments),
            },
          };
          break;
        }

        if (item.type === "reasoning") {
          const summary = reasoningText(item);
          if (!sawReasoningSummary && summary !== "") {
            sawReasoningSummary = true;
            yield {
              role: EVENT.REASONING_SUMMARY,
              content: { text: summary },
            };
          }
          const signature = serializeReasoningItem(item);
          if (signature && !emittedReasoning.has(signature)) {
            emittedReasoning.add(signature);
            yield {
              role: EVENT.REASONING_SIGNATURE,
              content: {
                kind: OPENAI_REASONING_KIND,
                signature,
                ...(summary !== "" ? { summary } : {}),
              },
            };
          }
          break;
        }

        if (item.type === "message" && !sawText && Array.isArray(item.content)) {
          const text = item.content
            .filter((content) => content?.type === "output_text")
            .map((content) => content.text ?? "")
            .join("");
          if (text !== "") {
            sawText = true;
            yield { role: EVENT.ASSISTANT, content: { text } };
          }
        }
        break;
      }

      case "response.completed":
        usage = event.response?.usage ?? usage;
        break;

      case "response.failed": {
        const error = event.response?.error;
        throw new Error(error?.message ?? "OpenAI response failed.");
      }

      case "error":
        throw new Error(event.message ?? "OpenAI stream error.");

      default:
        break;
    }
  }

  if (usage) {
    yield {
      role: EVENT.TOKEN,
      content: {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        total_tokens:
          usage.total_tokens ??
          (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        cached_tokens: usage.input_tokens_details?.cached_tokens ?? null,
        reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? null,
      },
    };
  }
}
