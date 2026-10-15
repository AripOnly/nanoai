// apps/cli/components/Banner.jsx

import React from "react";
import { Box, Text } from "ink";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANNER_TEXT = readFileSync(path.join(__dirname, "banner.txt"), "utf-8").trimEnd();

export default function Banner() {
  return (
    <Box marginBottom={1} paddingX={1} flexDirection="column">
      <Text color="#FFA500">{BANNER_TEXT}</Text>
    </Box>
  );
}
