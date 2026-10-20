// src/tools/read/read.js
//
// Unified read tool: text files (paged, line-numbered), directory listings,
// images/PDFs (stored as attachments by reference), and Word/Excel documents
// via the dedicated parsers in this folder. No permission popup (NanoAI
// approvals happen in conversation). Absolute paths may point anywhere;
// relative paths anchor at the workspace root.

import fs from "node:fs";
import { fail, resolveWorkspacePath, saveAttachment, suggestSimilarPaths } from "#src/tools/shared/index.js";
import { isBinaryFile, sniffMediaMime } from "./media.js";
import { isWordFile, readWordDocument } from "./word.js";
import { isSpreadsheetFile, readSpreadsheet } from "./excel.js";

const DEFAULT_LIMIT = 100;
const TEXT_SAMPLE_BYTES = 8 * 1024;

export const readTool = {
  type: "function",
  name: "read",
  description:
    "Read a file or list a directory. Text files are returned with line numbers " +
    "and support offset/limit paging. Images and PDFs are attached by reference " +
    "for the model to read natively. Word (.docx) and spreadsheets (.xlsx/.xls) " +
    "are parsed to text. Binary files are refused. " +
    "Relative paths resolve against the workspace root; absolute paths may point anywhere.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "File or directory to read. Relative paths anchor at the workspace root.",
      },
      offset: {
        type: "integer",
        description: "First line to show (1-based). Defaults to 1.",
      },
      limit: {
        type: "integer",
        description: "Maximum lines to show. Defaults to 100.",
      },
    },
    required: ["path"],
  },
};

// fail() lives in #src/tools/shared/fail.js (imported above).

function missError(requested, resolved) {
  const hints = suggestSimilarPaths(resolved);
  const hint = hints.length > 0 ? `\n\nDid you mean one of these?\n${hints.join("\n")}` : "";
  return fail(`Path does not exist: ${requested}${hint}`);
}

function readTextFile(resolved, { offset, limit }) {
  const content = fs.readFileSync(resolved, "utf8");
  const lines = content.split("\n");
  // A trailing newline does not create a phantom line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  if (offset > total) {
    return fail(`Line offset ${offset} is out of range (file has ${total} line${total === 1 ? "" : "s"}).`);
  }
  const end = Math.min(total, offset + limit - 1);
  const numbered = [];
  for (let i = offset; i <= end; i++) {
    numbered.push(`${i}: ${lines[i - 1]}`);
  }
  let output = `Showing lines ${offset}-${end} of ${total}\n${numbered.join("\n")}`;
  if (end >= total) {
    output += `\nEnd of file - total ${total} lines`;
  }
  return { success: true, output };
}

function readDirectory(resolved, requested) {
  let entries;
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (error) {
    return fail(`Cannot list directory '${requested}': ${error instanceof Error ? error.message : String(error)}`);
  }
  const names = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
  const output = `Directory listing of ${resolved} (${names.length} entries)\n${names.join("\n")}`;
  return { success: true, output };
}

async function readMediaFile(resolved, mime) {
  const bytes = fs.readFileSync(resolved);
  let reference;
  try {
    reference = await saveAttachment(bytes, mime);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const kind = mime === "application/pdf" ? "PDF document" : "image";
  return {
    success: true,
    output: `Attached ${kind} (${mime}, ${bytes.length} bytes) by reference for the model to read natively.`,
    attachments: [{ id: reference.id, mime: reference.mime, size: reference.size }],
  };
}

export async function read(params = {}, context = {}) {
  try {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return fail("Parameters must be an object with 'path' and optional 'offset'/'limit'.");
    }
    const { path: requested, offset = 1, limit = DEFAULT_LIMIT } = params;
    if (typeof requested !== "string" || requested.trim() === "") {
      return fail("Parameter 'path' must be a non-empty string.");
    }
    if (!Number.isInteger(offset) || offset < 1) {
      return fail("Parameter 'offset' must be a positive integer (1-based).");
    }
    if (!Number.isInteger(limit) || limit < 1) {
      return fail("Parameter 'limit' must be a positive integer.");
    }

    const resolved = resolveWorkspacePath(requested, context.policy);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return missError(requested, resolved);
    }
    if (stat.isDirectory()) {
      return readDirectory(resolved, requested);
    }

    // Office documents have dedicated parsers (checked before the binary
    // gate so legacy .xls is parsed, not refused).
    if (isWordFile(resolved)) {
      try {
        const { text, truncated } = await readWordDocument(fs.readFileSync(resolved));
        return { success: true, output: truncated ? `${text}\n...(truncated)` : text };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    }
    if (isSpreadsheetFile(resolved)) {
      try {
        const { text, truncated, sheets } = readSpreadsheet(fs.readFileSync(resolved));
        return { success: true, output: truncated ? `${text}\n...(truncated)` : text, sheets };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    }

    const sample = (() => {
      try {
        const descriptor = fs.openSync(resolved, "r");
        try {
          const buffer = Buffer.alloc(TEXT_SAMPLE_BYTES);
          const read = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
          return buffer.subarray(0, read);
        } finally {
          fs.closeSync(descriptor);
        }
      } catch {
        return Buffer.alloc(0);
      }
    })();

    const mime = sniffMediaMime(sample);
    if (mime) {
      return readMediaFile(resolved, mime);
    }
    if (isBinaryFile(resolved, sample)) {
      return fail(
        `Cannot read binary file '${requested}'. Binary formats (archives, executables, ` +
          "legacy .doc/.ppt) are not readable as text.",
      );
    }
    return readTextFile(resolved, { offset, limit });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
