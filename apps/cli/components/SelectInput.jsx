// SelectInput.jsx

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  MAX_VISIBLE_ITEMS,
  adjustWindow,
  nextCursor,
  visibleSlice,
} from "../lib/select-window.js";

const SelectInput = ({ items = [], onSelect, onCancel, isFocused = true }) => {
  const [cursor, setCursor] = useState(0);
  const [start, setStart] = useState(0);

  useEffect(() => {
    const total = items.length;
    const safeCursor =
      total === 0 ? 0 : Math.min(cursor, Math.max(0, total - 1));
    if (safeCursor !== cursor) setCursor(safeCursor);
    setStart((prev) =>
      adjustWindow(safeCursor, prev, total, MAX_VISIBLE_ITEMS),
    );
  }, [items.length, cursor]);

  const move = (dir) => {
    const total = items.length;
    if (!total) return;
    const next = nextCursor(cursor, dir, total);
    setCursor(next);
    setStart((prev) => adjustWindow(next, prev, total, MAX_VISIBLE_ITEMS));
  };

  useInput(
    (input, key) => {
      if (!isFocused) return;

      if (key.escape) {
        onCancel?.();
        return;
      }

      if (!items || items.length === 0) return;

      if (key.upArrow || input === "k") {
        move(-1);
        return;
      }

      if (key.downArrow || input === "j") {
        move(1);
        return;
      }

      if (key.return && items[cursor] !== undefined) {
        onSelect?.(items[cursor]);
      }
    },
    { isActive: isFocused },
  );

  const total = items.length;
  const scrollable = total > MAX_VISIBLE_ITEMS;
  const visible = scrollable
    ? visibleSlice(items, start, MAX_VISIBLE_ITEMS)
    : items;

  return (
    <Box flexDirection="column">
      {visible.map((item, vi) => {
        const index = scrollable ? start + vi : vi;
        return (
          <Box key={item.value ?? index}>
            <Box
              width={"100%"}
              paddingX={1}
              backgroundColor={index === cursor ? "#ffa857e8" : undefined}
              flexDirection="row"
              flexWrap="nowrap"
              gap={5}
            >
              <Box width={item?.description !== undefined ? 15 : undefined}>
                <Text color={index === cursor ? "#111111" : undefined}>
                  {item.label}
                </Text>
              </Box>
              <Box>
                <Text color={index === cursor ? "#111111" : "#858585"}>
                  {item?.description}
                </Text>
              </Box>
            </Box>
          </Box>
        );
      })}
      {scrollable && (
        <Box marginTop={1} paddingX={1}>
          <Text color="gray">
            {cursor + 1}/{total}
          </Text>
        </Box>
      )}
    </Box>
  );
};

export default SelectInput;
