// Chat.jsx

import React from "react";
import { Text, Box } from "ink";
import User from "./User.jsx";
import Response from "./Response.jsx";
import ToolCall from "./ToolCall.jsx";
import { attachToolResults } from "../lib/tool-display.js";

export default function BoxChat({ chat }) {
  return attachToolResults(chat).map((value, index) => {
    if (value.role === "user") {
      return <User key={index}>{value.content?.text ?? value.content}</User>;
    }

    if (value.role === "assistant") {
      return (
        <Response
          key={index}
          type="assistant"
          response={value.content?.text ?? value.content}
        />
      );
    }

    if (value.role === "tool_call") {
      return <ToolCall key={index} toolCall={value.content} />;
    }

    if (value.role === "tool_result") {
      const result = value.content?.result;
      const output =
        result && typeof result === "object" && typeof result.output === "string"
          ? result.output
          : typeof result === "string"
            ? result
            : JSON.stringify(result ?? "");
      return (
        <ToolCall
          key={index}
          toolCall={{ name: value.content?.name ?? "tool", arguments: "", preview: output }}
        />
      );
    }

    if (value.role === "error") {
      return (
        <Text key={index} color="red">
          {value.content.message ?? value.content}
        </Text>
      );
    }
  });
}
