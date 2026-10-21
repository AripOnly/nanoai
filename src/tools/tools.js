// src/tools/tools.js
//
// Legacy facade over the single tool manifest in registry.js. New code should
// import toolRegistry (schemas + capabilities) or executeTool (policy
// dispatch) directly; this file remains for older call sites that still use
// the `tools` / `schema` lookup objects.

import { toolRegistry } from "./registry.js";

const SCHEMA_KEYS = Object.freeze({
  read: "readTool",
  write: "writeTool",
  writeWord: "wordTool",
  writeExcel: "excelTool",
  edit: "editTool",
  shell: "shellTool",
  glob: "globTool",
  grep: "grepTool",
  webSearch: "webSearchTool",
  webFetch: "webFetchTool",
});

export const tools = Object.freeze(
  Object.fromEntries(
    toolRegistry.list().map((definition) => [definition.name, definition.execute]),
  ),
);

export const schema = Object.freeze(
  Object.fromEntries(
    toolRegistry
      .list()
      .map((definition) => [SCHEMA_KEYS[definition.name], definition.schema])
      .filter(([key]) => typeof key === "string"),
  ),
);
