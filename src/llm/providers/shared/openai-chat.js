// src/llm/providers/shared/openai-chat.js
//
// OpenAI Chat Completions wire: neutral history -> messages, tools, and a
// streaming normalizer. Also used by OpenRouter and OpenCode Zen.

import { EVENT } from "#src/shared/event-type.js";
import {
  dataUrl,
  modelId,
  parseArguments,
  resultImages,
  resultText,
  resultSubcontents,
  stringifyArguments,
} from "./values.js";

function textPart(part) {
  return String(part?.content?.text ?? "");
}

function toChatTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

/**
 * Convert neutral conversation parts to Chat Completions messages.
 *
 * Chat tool messages accept text only, so tool-result images are emitted as a
 * following user message. That keeps the tool_call_id protocol valid while
 * still sending the bytes exactly once.
 */
export function toChatMessages(input = [], instruction = "", options = {}) {
  const messages = [];
  const pendingImages = [];

  function flushImages() {
    if (pendingImages.length === 0) return;
    messages.push({ role: "user", content: [...pendingImages] });
    pendingImages.length = 0;
  }

  function assistantMessage() {
    const last = messages.at(-1);
    if (last?.role === "assistant") return last;
    const message = { role: "assistant", content: null };
    messages.push(message);
    return message;
  }

  if (typeof instruction === "string" && instruction.trim() !== "") {
    messages.push({ role: "system", content: instruction });
  }

  for (const part of input) {
    switch (part?.role) {
      case EVENT.USER:
        flushImages();
        messages.push({ role: "user", content: textPart(part) });
        break;

      case EVENT.ASSISTANT: {
        flushImages();
        const text = textPart(part);
        if (text === "") break;
        const last = messages.at(-1);
        if (last?.role === "assistant") {
          last.content = `${last.content ?? ""}${text}`;
        } else {
          messages.push({ role: "assistant", content: text });
        }
        break;
      }

      case EVENT.REASONING_SIGNATURE:
        // Chat Completions is stateless and has no portable reasoning item.
        // Some providers put a signature on the function call itself; that is
        // preserved below when the provider supports extra_content.
        break;

      case EVENT.TOOL_CALL: {
        flushImages();
        const content = part.content ?? {};
        const message = assistantMessage();
        if (!Array.isArray(message.tool_calls)) message.tool_calls = [];
        const call = {
          id: content.call_id ?? `call_${messages.length}_${message.tool_calls.length}`,
          type: "function",
          function: {
            name: content.name,
            arguments: stringifyArguments(content.arguments),
          },
        };
        if (options.preserveToolSignatures && content.signature != null) {
          call.extra_content = {
            google: { thought_signature: content.signature },
          };
        }
        message.tool_calls.push(call);
        break;
      }

      case EVENT.TOOL_RESULT: {
        const content = part.content ?? {};
        messages.push({
          role: "tool",
          tool_call_id: content.call_id,
          content: resultText(content.result),
        });
        if (resultSubcontents(content.result)) {
          for (const image of resultImages(content.result)) {
            if (!image.mime.startsWith("image/")) continue;
            pendingImages.push({
              type: "image_url",
              image_url: { url: dataUrl(image.mime, image.data) },
            });
          }
        }
        break;
      }

      default:
        break;
    }
  }

  flushImages();
  return messages;
}

function chatReasoning(delta) {
  const direct = delta?.reasoning_content ?? delta?.reasoning;
  if (typeof direct === "string" && direct !== "") return direct;
  if (!Array.isArray(delta?.reasoning_details)) return "";
  return delta.reasoning_details
    .map((detail) => detail?.text ?? detail?.summary ?? "")
    .filter((text) => typeof text === "string" && text !== "")
    .join("");
}

/**
 * Stream one Chat Completions request. Yields only provider-neutral events.
 */
export async function* requestChat({
  client,
  request,
  input,
  preserveToolSignatures = false,
}) {
  const body = {
    model: modelId(request.model),
    messages: toChatMessages(input, request.instruction, {
      preserveToolSignatures,
    }),
    stream: true,
    stream_options: { include_usage: true },
  };

  const tools = toChatTools(request.tools);
  if (tools) body.tools = tools;

  const stream = await client.chat.completions.create(body, {
    signal: request.signal,
  });

  const toolCalls = new Map();
  let usage = null;

  for await (const chunk of stream) {
    if (chunk?.error) {
      throw new Error(chunk.error.message ?? String(chunk.error));
    }

    const choice = chunk?.choices?.[0];
    const delta = choice?.delta;

    if (delta) {
      if (typeof delta.content === "string" && delta.content !== "") {
        yield { role: EVENT.ASSISTANT, content: { text: delta.content } };
      }
      if (typeof delta.refusal === "string" && delta.refusal !== "") {
        yield { role: EVENT.ASSISTANT, content: { text: delta.refusal } };
      }

      const reasoning = chatReasoning(delta);
      if (reasoning !== "") {
        yield { role: EVENT.REASONING_SUMMARY, content: { text: reasoning } };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tool of delta.tool_calls) {
          const index = Number.isInteger(tool?.index) ? tool.index : 0;
          const state = toolCalls.get(index) ?? {
            id: "",
            name: "",
            arguments: "",
            signature: null,
          };
          if (typeof tool?.id === "string" && tool.id !== "") {
            state.id = tool.id;
          }
          if (typeof tool?.function?.name === "string") {
            state.name += tool.function.name;
          }
          if (typeof tool?.function?.arguments === "string") {
            state.arguments += tool.function.arguments;
          }
          const signature =
            tool?.extra_content?.google?.thought_signature ??
            tool?.function?.extra_content?.google?.thought_signature;
          if (typeof signature === "string" && signature !== "") {
            state.signature = signature;
          }
          toolCalls.set(index, state);
        }
      }
    }

    if (chunk?.usage) usage = chunk.usage;
  }

  const ordered = [...toolCalls.entries()].sort(([a], [b]) => a - b);
  for (const [index, call] of ordered) {
    if (!call.name) continue;
    yield {
      role: EVENT.TOOL_CALL,
      content: {
        call_id: call.id || `call_${index}`,
        name: call.name,
        arguments: parseArguments(call.arguments),
        ...(call.signature != null ? { signature: call.signature } : {}),
      },
    };
  }

  if (usage) {
    yield {
      role: EVENT.TOKEN,
      content: {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        total_tokens:
          usage.total_tokens ??
          (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
        cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? null,
        reasoning_tokens:
          usage.completion_tokens_details?.reasoning_tokens ?? null,
      },
    };
  }
}
