// src/agents/registry.js

import { schema } from "#src/tools/tools.js";

const nano = {
  mode: "primary",
  instruction: "default",
  tools: [
    schema.readTool,
    schema.writeTool,
    schema.wordTool,
    schema.excelTool,
    schema.editTool,
    schema.shellTool,
    schema.globTool,
    schema.grepTool,
    schema.webSearchTool,
    schema.webFetchTool,
  ],
};

const plan = {
  mode: "primary",
  instruction: "plan",
  tools: [schema.readTool, schema.globTool, schema.grepTool, schema.webSearchTool, schema.webFetchTool],
};

const compaction = {
  mode: "subagent",
  instruction: "compaction",
  tools: [],
};

export const agents = {
  nano,
  plan,
  compaction,
};
