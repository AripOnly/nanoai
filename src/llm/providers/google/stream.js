// src/provider/google/google-clean-output.js

import { EVENT } from "#src/shared/event-type.js";

function parseArguments(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return {};

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function* stream(llmStream) {
  let currentStepType = null;

  const toolState = {
    signature: null,
    id: null,
    name: null,
    arguments: "",
  };

  for await (const event of llmStream) {
    switch (event.event_type) {
      case "step.start":
        currentStepType = event.step.type;

        if (currentStepType === "function_call") {
          toolState.id = event.step.id;
          toolState.signature = event.step.signature ?? null;
          toolState.name = event.step.name;
          toolState.arguments = "";
        }
        break;

      case "step.delta": {
        const delta = event.delta;

        switch (delta.type) {
          case "text":
            yield {
              role: EVENT.ASSISTANT,
              content: {
                text: delta.text,
              },
            };
            break;

          case "thought_summary":
            yield {
              role: EVENT.REASONING_SUMMARY,
              content: {
                text: delta.content.text,
              },
            };
            break;

          case "thought_signature":
            yield {
              role: EVENT.REASONING_SIGNATURE,
              content: {
                signature: delta.signature,
              },
            };
            break;

          case "arguments_delta":
            toolState.arguments += delta.arguments;
            break;
        }

        break;
      }

      case "step.stop":
        if (currentStepType === "function_call") {
          yield {
            role: EVENT.TOOL_CALL,
            content: {
              signature: toolState.signature,
              call_id: toolState.id,
              name: toolState.name,
              arguments: parseArguments(toolState.arguments),
            },
          };

          toolState.signature = null;
          toolState.id = null;
          toolState.name = null;
          toolState.arguments = "";
        }

        currentStepType = null;
        break;

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
