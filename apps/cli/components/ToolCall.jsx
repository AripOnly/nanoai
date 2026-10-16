import React from "react";
import { Box, Text } from "ink";
import { formatToolTarget, formatToolError } from "../lib/tool-display.js";

const ToolCall = React.memo(function ToolCall({ toolCall }) {
  const arg = formatToolTarget(toolCall.name, toolCall.arguments);
  // UI minimal: header selalu cetak, body result/preview normal
  // TIDAK dirender. Satu-satunya pengecualian: error (merah) agar kegagalan
  // tool tetap terlihat tanpa mengandalkan teks jawaban agent.
  const errorText = formatToolError(toolCall);

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
      {errorText ? (
        <Box marginLeft={4} width="100%">
          <Text color="red" wrap="truncate-end">
            {errorText}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});

export default ToolCall;
