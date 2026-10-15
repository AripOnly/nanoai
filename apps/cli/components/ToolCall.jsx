import React from "react";
import { Box, Text } from "ink";
import { formatToolTarget, formatPreview } from "../lib/tool-display.js";

const ToolCall = React.memo(function ToolCall({ toolCall }) {
  const arg = formatToolTarget(toolCall.name, toolCall.arguments);
  const preview = formatPreview(toolCall.preview);
  const result = toolCall.result;
  // New tools return `output`; webSearch returns `content`; failures carry `error`.
  const resultText =
    result && typeof result === "object"
      ? typeof result.output === "string"
        ? formatPreview(result.output)
        : typeof result.content === "string"
          ? formatPreview(result.content)
          : result.success === false && typeof result.error === "string"
            ? formatPreview(`Error: ${result.error}`)
            : ""
      : "";
  const liveText = resultText || preview;

  return (
    <Box
      flexDirection="column"
      flexWrap="nowrap"
      width="100%"
      marginTop={1}
      alignItems="flex-start"
    >
      <Box flexDirection="row" flexWrap="nowrap" width="100%" gap={1}>
        <Box>
          <Text>🔧</Text>
        </Box>
        <Box>
          <Text color="#F6850C">{toolCall.name}: </Text>
          <Text color="#898989" wrap="truncate">
            {arg}
          </Text>
        </Box>
      </Box>
      {liveText ? (
        <Box marginLeft={4} width="100%">
          <Text color="#6E6E6E" wrap="truncate-end">
            {liveText}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});

export default ToolCall;
