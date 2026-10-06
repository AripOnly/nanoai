import { GoogleGenAI } from "@google/genai";
import "dotenv/config";
import { stream } from "./stream.js";
import { EVENT } from "../../../shared/event-type.js";
import { settings } from "../../../config/setting.js";

let client = null;

async function getClient() {
  if (!client) {
    const apiKey = await settings.get("api_key");
    if (!apiKey) {
      throw new Error("API key not configured. Run setup first.");
    }
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

function toGemini(part) {
  const role = part.role ?? "text";

  if (role === EVENT.TOKEN || role === EVENT.ERROR || role === EVENT.COMPACTION)
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

    const input = request.input.map(toGemini).filter((part) => part != null);

    // yield {
    //   role: EVENT.ASSISTANT,
    //   content: {
    //     text: "ok",
    //   },
    // };

    // return;

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

    const llmStream = await client.interactions.create(body);

    yield* stream(llmStream);
  } catch (err) {
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

    yield {
      role: EVENT.ERROR,
      content: {
        message: `error: ${err}\nmessage: ${message}`,
      },
    };
  }
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
    const functionResult = {
      role: EVENT.TOOL_RESULT,
      content: {
        type: "tool_result",
        call_id: toolCall[i].call_id,
        name: toolCall[i].name,
        result: toolResult[i],
      },
    };

    if (toolCall[i].signature != null) {
      functionResult.content.signature = toolCall[i].signature;
    }

    parts.push(functionResult);
  }

  return parts;
}
