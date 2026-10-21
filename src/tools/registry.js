// src/tools/registry.js
//
// The single tool manifest. Every tool is declared once here with its schema,
// capability envelope, and implementation; the agent loop receives only the
// schemas of the tools the agent policy allows, and the executor dispatches by
// name. Adding a tool never touches agent code.

import { read, readTool } from "./read/read.js";
import { write, writeTool } from "./write/write.js";
import { writeWord, wordTool } from "./write/word.js";
import { writeExcel, excelTool } from "./write/excel.js";
import { edit, editTool } from "./edit.js";
import { webSearch, webSearchTool } from "./web/search.js";
import { webFetch, webFetchTool } from "./web/fetch.js";
import { shell, shellTool } from "./shell/shell.js";
import { process, processTool } from "./process/process.js";
import { glob, globTool } from "./glob.js";
import { grep, grepTool } from "./grep.js";
import { assertToolContract } from "./contract.js";

const READ_FS = Object.freeze({ fs: "read", net: false, shell: false });
const WRITE_FS = Object.freeze({ fs: "write", net: false, shell: false });
const READ_NET = Object.freeze({ fs: false, net: true, shell: false });
const SHELL = Object.freeze({ fs: "write", net: true, shell: true });

export const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "read",
    schema: readTool,
    capabilities: READ_FS,
    execute: read,
  }),
  Object.freeze({
    name: "write",
    schema: writeTool,
    capabilities: WRITE_FS,
    execute: write,
  }),
  Object.freeze({
    name: "writeWord",
    schema: wordTool,
    capabilities: WRITE_FS,
    execute: writeWord,
  }),
  Object.freeze({
    name: "writeExcel",
    schema: excelTool,
    capabilities: WRITE_FS,
    execute: writeExcel,
  }),
  Object.freeze({
    name: "edit",
    schema: editTool,
    capabilities: WRITE_FS,
    execute: edit,
  }),
  Object.freeze({
    name: "shell",
    schema: shellTool,
    capabilities: SHELL,
    execute: shell,
  }),
  Object.freeze({
    name: "process",
    schema: processTool,
    capabilities: SHELL,
    execute: process,
  }),
  Object.freeze({
    name: "glob",
    schema: globTool,
    capabilities: READ_FS,
    execute: glob,
  }),
  Object.freeze({
    name: "grep",
    schema: grepTool,
    capabilities: READ_FS,
    execute: grep,
  }),
  Object.freeze({
    name: "webSearch",
    schema: webSearchTool,
    capabilities: READ_NET,
    execute: webSearch,
  }),
  Object.freeze({
    name: "webFetch",
    schema: webFetchTool,
    capabilities: READ_NET,
    execute: webFetch,
  }),
]);

export function createToolRegistry(definitions = TOOL_DEFINITIONS) {
  const byName = new Map();

  for (const definition of definitions) {
    assertToolContract(definition);
    if (byName.has(definition.name)) {
      throw new Error(`Duplicate tool definition: ${definition.name}.`);
    }
    byName.set(definition.name, definition);
  }

  const names = Object.freeze([...byName.keys()]);

  return Object.freeze({
    names() {
      return names;
    },
    list() {
      return Object.freeze([...byName.values()]);
    },
    get(name) {
      return byName.get(name);
    },
    has(name) {
      return byName.has(name);
    },
    schemasFor(requested = null) {
      if (requested == null) {
        return [...byName.values()].map((definition) => definition.schema);
      }

      const names = [...new Set(requested)];
      const missing = names.filter((name) => !byName.has(name));
      if (missing.length > 0) {
        throw new Error(`Unknown tool(s): ${missing.join(", ")}.`);
      }
      return names.map((name) => byName.get(name).schema);
    },
  });
}

export const toolRegistry = createToolRegistry();
