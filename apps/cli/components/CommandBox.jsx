// CommandBox.jsx

import React from "react";
import { Box, Text } from "ink";
import SelectInput from "./SelectInput.jsx";

const COMMANDS = [
  { value: "session", label: "/session", description: "switch session" },
  { value: "new", label: "/new", description: "new session" },
  { value: "model", label: "/model", description: "switch model" },
  { value: "provider", label: "/provider", description: "set provider API key" },
  { value: "exit", label: "/exit", description: "quit" },
];

const CommandBox = ({ filter = "", onSelect, onCancel }) => {
  const items = COMMANDS.filter((cmd) =>
    cmd.value.startsWith(filter.toLowerCase()),
  );

  return (
    <Box width={"100%"} flexDirection="column">
      <Text color="gray">Commands</Text>
      {items.length === 0 && (
        <Box paddingX={1}>
          <Text color="gray">No matching commands</Text>
        </Box>
      )}
      <SelectInput items={items} onSelect={onSelect} onCancel={onCancel} />
    </Box>
  );
};

export default CommandBox;
