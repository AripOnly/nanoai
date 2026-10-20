// BoxChat.jsx

import React from "react";
import { Text } from "ink";
import User from "./User.jsx";
import Response from "./Response.jsx";
import ToolCall from "./ToolCall.jsx";
import { attachToolResults } from "../lib/tool-display.js";
import { getCallId } from "#src/shared/call-id.js";
import { EVENT } from "#src/shared/event-type.js";

export default function BoxChat({ chat }) {
  if (!Array.isArray(chat) || chat.length === 0) return null;

  return attachToolResults(chat).map((value, index) => {
    if (value.role === EVENT.USER) {
      return <User key={index}>{value.content?.text ?? value.content}</User>;
    }

    if (value.role === EVENT.ASSISTANT) {
      return (
        <Response
          key={index}
          type="assistant"
          response={value.content?.text ?? value.content}
        />
      );
    }

    if (value.role === EVENT.COMPACTION) {
      return (
        <Response
          key={index}
          type="compaction"
          response={value.content?.text ?? value.content}
        />
      );
    }

    if (value.role === EVENT.TOOL_CALL) {
      // Key stabil per call_id: update preview/result menimpa baris yang sama,
      // menimpa baris yang sama, header tidak pernah tercetak ulang.
      return <ToolCall key={getCallId(value.content) ?? `call-${index}`} toolCall={value.content} />;
    }

    if (value.role === EVENT.TOOL_RESULT) {
      const result = value.content?.result;
      const output =
        result && typeof result === "object" && typeof result.output === "string"
          ? result.output
          : typeof result === "string"
            ? result
            : JSON.stringify(result ?? "");
      return (
        <ToolCall
          key={getCallId(value.content) ?? `result-${index}`}
          toolCall={{ name: value.content?.name ?? "tool", arguments: "", preview: output }}
        />
      );
    }

    if (value.role === EVENT.ERROR) {
      const message =
        value.content?.message ??
        (typeof value.content === "string"
          ? value.content
          : JSON.stringify(value.content ?? ""));
      return (
        <Text key={index} color="red">
          {message}
        </Text>
      );
    }

    return null;
  });
}
