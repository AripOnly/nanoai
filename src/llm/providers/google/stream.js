// src/llm/providers/google/stream.js
//
// Gemini Interactions SSE normalizer. Thought signatures are emitted as one
// complete thought event at step.stop, paired with the summary that arrived in
// the same step. They are never attached to function calls or results.

import { EVENT } from "#src/shared/event-type.js";
import { GOOGLE_THINKING_KIND } from "./constants.js";

function parseArguments(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return {};

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function summaryText(summary) {
  if (typeof summary === "string") return summary;
  if (!Array.isArray(summary)) return "";
  return summary
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

function mergeSummary(current, next) {
  if (next === "") return current;
  if (current === "") return next;
  if (next === current || next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  return `${current}${next}`;
}

function mergeSignature(current, next) {
  if (typeof next !== "string" || next === "") return current;
  if (current === "") return next;
  if (next === current || next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  return `${current}${next}`;
}

export async function* stream(llmStream) {
  let currentStepType = null;
  let thoughtState = null;

  const toolState = {
    id: null,
    name: null,
    arguments: "",
  };

  for await (const event of llmStream) {
    switch (event.event_type) {
      case "step.start": {
        currentStepType = event.step?.type ?? null;

        if (currentStepType === "thought") {
          thoughtState = {
            summary: summaryText(event.step?.summary),
            signature:
              typeof event.step?.signature === "string"
                ? event.step.signature
                : "",
            emittedSummary: false,
          };
        } else if (currentStepType === "function_call") {
          toolState.id = event.step?.id ?? null;
          toolState.name = event.step?.name ?? null;
          toolState.arguments = "";
        }
        break;
      }

      case "step.delta": {
        const delta = event.delta;
        if (!delta) break;

        switch (delta.type) {
          case "text":
            if (typeof delta.text === "string" && delta.text !== "") {
              yield {
                role: EVENT.ASSISTANT,
                content: { text: delta.text },
              };
            }
            break;

          case "thought_summary": {
            const text =
              typeof delta.content?.text === "string"
                ? delta.content.text
                : typeof delta.text === "string"
                  ? delta.text
                  : "";
            if (text === "") break;
            if (thoughtState) {
              thoughtState.summary = mergeSummary(thoughtState.summary, text);
              thoughtState.emittedSummary = true;
            }
            yield {
              role: EVENT.REASONING_SUMMARY,
              content: { text },
            };
            break;
          }

          case "thought_signature":
            if (thoughtState) {
              thoughtState.signature = mergeSignature(
                thoughtState.signature,
                delta.signature,
              );
            }
            break;

          case "arguments_delta":
            toolState.arguments += delta.arguments ?? "";
            break;
        }

        break;
      }

      case "step.stop": {
        if (currentStepType === "thought") {
          const signature = mergeSignature(
            thoughtState?.signature ?? "",
            event.step?.signature,
          );
          if (thoughtState && !thoughtState.emittedSummary && thoughtState.summary) {
            yield {
              role: EVENT.REASONING_SUMMARY,
              content: { text: thoughtState.summary },
            };
          }
          if (signature !== "") {
            yield {
              role: EVENT.REASONING_SIGNATURE,
              content: {
                kind: GOOGLE_THINKING_KIND,
                signature,
                ...(thoughtState?.summary
                  ? { summary: thoughtState.summary }
                  : {}),
              },
            };
          }
          thoughtState = null;
        } else if (currentStepType === "function_call") {
          yield {
            role: EVENT.TOOL_CALL,
            content: {
              call_id: toolState.id,
              name: toolState.name,
              arguments: parseArguments(toolState.arguments),
            },
          };

          toolState.id = null;
          toolState.name = null;
          toolState.arguments = "";
        }

        currentStepType = null;
        break;
      }

      case "interaction.completed": {
        const usage = event.interaction?.usage ?? {};
        yield {
          role: EVENT.TOKEN,
          content: {
            input_tokens: usage.total_input_tokens ?? 0,
            output_tokens: usage.total_output_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0,
          },
        };
        break;
      }
    }
  }
}
