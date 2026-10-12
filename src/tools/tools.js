// src/tools/tools.js

import { read, readTool } from "./read/read.js";
import { write, writeTool } from "./write/write.js";
import { writeWord, wordTool } from "./write/word.js";
import { writeExcel, excelTool } from "./write/excel.js";
import { edit, editTool } from "./edit.js";
import { webSearch, webSearchTool } from "./web/search.js";
import { webFetch, webFetchTool } from "./web/fetch.js";
import { shell, shellTool } from "./shell/shell.js";
import { glob, globTool } from "./glob.js";
import { grep, grepTool } from "./grep.js";

export const tools = {
  read,
  write,
  writeWord,
  writeExcel,
  edit,
  shell,
  glob,
  grep,
  webSearch,
  webFetch,
};

export const schema = {
  readTool,
  writeTool,
  wordTool,
  excelTool,
  editTool,
  shellTool,
  globTool,
  grepTool,
  webSearchTool,
  webFetchTool,
};
