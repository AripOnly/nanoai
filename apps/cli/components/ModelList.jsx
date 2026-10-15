import React from "react";
import { Box, Text } from "ink";
import SelectInput from "./SelectInput.jsx";

const ModelList = ({ provider, models = {}, onSelect, onCancel }) => {
  let items;

  if (models && models[provider] !== undefined) {
    items = models[provider].map((model) => ({
      value: model.id,
      label: model.name,
    }));
  } else {
    items = [
      {
        value: null,
        label: "no models",
      },
    ];
  }

  return (
    <Box width="100%" flexDirection="column">
      <Text color="gray">Model</Text>
      <SelectInput items={items} onSelect={onSelect} onCancel={onCancel} />
    </Box>
  );
};

export default ModelList;
