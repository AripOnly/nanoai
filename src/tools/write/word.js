// src/tools/write/word.js
//
// Word document (.docx) writer via the `docx` package (dolanmiu), the
// production-standard declarative .docx builder (pure JS, no native deps).
// Input is an explicit block list (headings, paragraphs, bullets, numbered
// items, tables) because structured JSON validates deterministically,
// unlike a markdown subset the model might format ambiguously.

import path from "node:path";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import { resolveWorkspaceRoot } from "#src/tools/shared/workspace.js";

const MAX_BLOCKS = 500;
const MAX_TABLE_ROWS = 1000;
const MAX_TABLE_COLS = 50;
const MAX_TEXT_CHARS = 20_000;

export const wordTool = {
  type: "function",
  name: "writeWord",
  description:
    "Creates a Word document (.docx) from structured blocks. " +
    "Use this when the user explicitly asks for a Word document. " +
    "Each block is a heading (level 1-6), paragraph, bullet, numbered item, or table. " +
    "Tables must be rectangular (every row has the same number of cells).",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      filePath: {
        type: "string",
        description: "The .docx file path to create. Relative paths resolve against the default save folder (nano-workspace); absolute paths may point anywhere.",
      },
      title: {
        type: "string",
        description: "Optional document title used as the first level-1 heading.",
      },
      blocks: {
        type: "array",
        description: "Ordered document blocks.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              enum: ["heading", "paragraph", "bullet", "numbered", "table"],
            },
            level: { type: "integer", minimum: 1, maximum: 6 },
            text: { type: "string" },
            bold: { type: "boolean" },
            rows: {
              type: "array",
              items: { type: "array", items: { type: "string" } },
            },
          },
          required: ["type"],
        },
      },
    },
    required: ["filePath", "blocks"],
  },
};

function fail(error) {
  return { success: false, error };
}

function assertText(value, where) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where} must be a non-empty string.`);
  }
  if (value.length > MAX_TEXT_CHARS) {
    throw new Error(`${where} exceeds the ${MAX_TEXT_CHARS} character limit. Split it into smaller blocks.`);
  }
  return value;
}

// Minimal inline markup shared with chat conventions: **bold** and *italic*.
function inlineRuns(text, base = {}) {
  const runs = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) runs.push(new TextRun({ text: text.slice(last, match.index), ...base }));
    const token = match[0];
    if (token.startsWith("**")) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true, ...base }));
    } else {
      runs.push(new TextRun({ text: token.slice(1, -1), italics: true, ...base }));
    }
    last = match.index + token.length;
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), ...base }));
  if (runs.length === 0) runs.push(new TextRun({ text, ...base }));
  return runs;
}

function headingLevel(level) {
  switch (level) {
    case 1:
      return HeadingLevel.HEADING_1;
    case 2:
      return HeadingLevel.HEADING_2;
    case 3:
      return HeadingLevel.HEADING_3;
    case 4:
      return HeadingLevel.HEADING_4;
    case 5:
      return HeadingLevel.HEADING_5;
    default:
      return HeadingLevel.HEADING_6;
  }
}

function buildParagraph(block, index) {
  const where = `blocks[${index}]`;
  if (block.type === "heading") {
    const level = block.level ?? 1;
    if (!Number.isInteger(level) || level < 1 || level > 6) {
      throw new Error(`${where}.level must be an integer between 1 and 6.`);
    }
    return new Paragraph({ heading: headingLevel(level), children: inlineRuns(assertText(block.text, `${where}.text`)) });
  }
  if (block.type === "paragraph") {
    return new Paragraph({
      children: inlineRuns(assertText(block.text, `${where}.text`), block.bold === true ? { bold: true } : {}),
    });
  }
  if (block.type === "bullet") {
    return new Paragraph({ bullet: { level: 0 }, children: inlineRuns(assertText(block.text, `${where}.text`)) });
  }
  if (block.type === "numbered") {
    return new Paragraph({ numbering: { reference: "nano-numbering", instance: 0 }, children: inlineRuns(assertText(block.text, `${where}.text`)) });
  }
  if (block.type === "table") {
    if (!Array.isArray(block.rows) || block.rows.length === 0) {
      throw new Error(`${where}.rows must be a non-empty array of string arrays.`);
    }
    if (block.rows.length > MAX_TABLE_ROWS) {
      throw new Error(`${where}.rows exceeds the ${MAX_TABLE_ROWS} row limit.`);
    }
    const width = block.rows[0].length;
    if (!Array.isArray(block.rows[0]) || width === 0 || width > MAX_TABLE_COLS) {
      throw new Error(`${where}.rows must be rectangular with 1-${MAX_TABLE_COLS} columns.`);
    }
    block.rows.forEach((row, r) => {
      if (!Array.isArray(row) || row.length !== width) {
        throw new Error(`${where}.rows[${r}] must have exactly ${width} string cells.`);
      }
      row.forEach((cell, c) => {
        if (typeof cell !== "string") {
          throw new Error(`${where}.rows[${r}][${c}] must be a string.`);
        }
        if (cell.length > MAX_TEXT_CHARS) {
          throw new Error(`${where}.rows[${r}][${c}] exceeds the ${MAX_TEXT_CHARS} character limit.`);
        }
      });
    });
    return new Table({
      rows: block.rows.map(
        (row) =>
          new TableRow({
            children: row.map((cell) => new TableCell({ children: [new Paragraph(cell)] })),
          }),
      ),
    });
  }
  throw new Error(`${where}.type must be one of: heading, paragraph, bullet, numbered, table.`);
}

function resolveOutputPath(filePath) {
  const root = resolveWorkspaceRoot();
  const resolved = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(root, filePath);
  if (!resolved.toLowerCase().endsWith(".docx")) {
    throw new Error("Word output path must end with .docx.");
  }
  return resolved;
}

export async function writeWord(params = {}, context = {}) {
  void context;
  try {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return fail("Parameters must be an object with 'filePath', optional 'title' and 'blocks'.");
    }
    const { filePath, title, blocks } = params;
    if (typeof filePath !== "string" || filePath.trim() === "") {
      return fail("Parameter 'filePath' must be a non-empty string.");
    }
    if (title !== undefined && (typeof title !== "string" || title.trim() === "")) {
      return fail("Parameter 'title' must be a non-empty string when provided.");
    }
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return fail("Parameter 'blocks' must be a non-empty array.");
    }
    if (blocks.length > MAX_BLOCKS) {
      throw new Error(`Parameter 'blocks' exceeds the ${MAX_BLOCKS} block limit.`);
    }
    for (const [index, block] of blocks.entries()) {
      if (typeof block !== "object" || block === null || Array.isArray(block)) {
        throw new Error(`blocks[${index}] must be an object.`);
      }
    }

    let resolved;
    try {
      resolved = resolveOutputPath(filePath);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    let children;
    try {
      children = [];
      if (title !== undefined) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: inlineRuns(title) }));
      }
      blocks.forEach((block, index) => children.push(buildParagraph(block, index)));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    let buffer;
    try {
      const document = new Document({
        numbering: {
          config: [
            {
              reference: "nano-numbering",
              levels: [
                { level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START },
              ],
            },
          ],
        },
        sections: [{ children }],
      });
      buffer = await Packer.toBuffer(document);
    } catch (error) {
      return fail(`Cannot build Word document: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, buffer);
    } catch (error) {
      return fail(`Cannot write file: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      success: true,
      output: `Word document created: ${resolved} (${blocks.length} blocks).`,
      blocks: blocks.length,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
