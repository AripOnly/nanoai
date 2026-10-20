// src/tools/write/excel.js
//
// Spreadsheet (.xlsx) writer via SheetJS, the production-standard
// spreadsheet library (pure JS, no native deps). Input is explicit
// sheet/row/cell data so validation is deterministic: rectangular rows,
// scalar cells only, Excel's own limits (31-char sheet names,
// ~1M rows x 16K columns) enforced with clear messages.

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import XLSX from "xlsx";
import { fail, resolveWorkspacePath } from "#src/tools/shared/index.js";

const MAX_SHEETS = 50;
const MAX_ROWS = 100_000;
const MAX_COLS = 500;
const MAX_SHEET_NAME_CHARS = 31;

export const excelTool = {
  type: "function",
  name: "writeExcel",
  description:
    "Creates an Excel spreadsheet (.xlsx) from structured sheet data. " +
    "Use this when the user explicitly asks for a spreadsheet. " +
    "Each sheet has an optional name and rows as arrays of text, numbers, true/false, or null. " +
    "Rows should be rectangular (same number of cells); shorter rows are padded with empty cells.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      filePath: {
        type: "string",
        description: "The .xlsx file path to create. Relative paths resolve against the default save folder (nano-workspace); absolute paths may point anywhere.",
      },
      sheets: {
        type: "array",
        description: "Workbook sheets in order.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            rows: {
              type: "array",
              items: {
                type: "array",
                items: { type: ["string", "number", "boolean", "null"] },
              },
            },
          },
          required: ["rows"],
        },
      },
    },
    required: ["filePath", "sheets"],
  },
};

// fail() lives in #src/tools/shared/fail.js (imported above).

function cleanCell(value, where) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${where} must be a finite number.`);
    }
    return value;
  }
  throw new Error(`${where} must be a string, number, boolean, or null.`);
}

function resolveOutputPath(filePath, policy) {
  const resolved = resolveWorkspacePath(filePath, policy);
  if (!resolved.toLowerCase().endsWith(".xlsx")) {
    throw new Error("Spreadsheet output path must end with .xlsx.");
  }
  return resolved;
}

export async function writeExcel(params = {}, context = {}) {
  try {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return fail("Parameters must be an object with 'filePath' and 'sheets'.");
    }
    const { filePath, sheets } = params;
    if (typeof filePath !== "string" || filePath.trim() === "") {
      return fail("Parameter 'filePath' must be a non-empty string.");
    }
    if (!Array.isArray(sheets) || sheets.length === 0) {
      return fail("Parameter 'sheets' must be a non-empty array.");
    }
    if (sheets.length > MAX_SHEETS) {
      return fail(`Parameter 'sheets' exceeds the ${MAX_SHEETS} sheet limit.`);
    }

    const names = new Set();
    const prepared = sheets.map((sheet, index) => {
      const where = `sheets[${index}]`;
      if (typeof sheet !== "object" || sheet === null || Array.isArray(sheet)) {
        throw new Error(`${where} must be an object with 'rows' and optional 'name'.`);
      }
      const name = sheet.name === undefined ? `Sheet${index + 1}` : sheet.name;
      if (typeof name !== "string" || name.trim() === "" || name.length > MAX_SHEET_NAME_CHARS) {
        throw new Error(`${where}.name must be 1-${MAX_SHEET_NAME_CHARS} characters (Excel limit).`);
      }
      if (names.has(name.toLowerCase())) {
        throw new Error(`${where}.name duplicates another sheet name: "${name}".`);
      }
      names.add(name.toLowerCase());
      if (!Array.isArray(sheet.rows) || sheet.rows.length === 0) {
        throw new Error(`${where}.rows must be a non-empty array of cell arrays.`);
      }
      if (sheet.rows.length > MAX_ROWS) {
        throw new Error(`${where}.rows exceeds the ${MAX_ROWS} row limit.`);
      }
      const width = Math.max(...sheet.rows.map((row) => (Array.isArray(row) ? row.length : -1)));
      if (width < 0 || width === 0 || width > MAX_COLS) {
        throw new Error(`${where}.rows must contain cell arrays with 1-${MAX_COLS} cells.`);
      }
      const rows = sheet.rows.map((row, r) => {
        if (!Array.isArray(row)) {
          throw new Error(`${where}.rows[${r}] must be an array of cells.`);
        }
        const cells = row.map((cell, c) => cleanCell(cell, `${where}.rows[${r}][${c}]`));
        while (cells.length < width) cells.push(null);
        return cells;
      });
      return { name, rows };
    });

    let resolved;
    try {
      resolved = resolveOutputPath(filePath, context.policy);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    let buffer;
    try {
      const workbook = XLSX.utils.book_new();
      for (const sheet of prepared) {
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
      }
      buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    } catch (error) {
      return fail(`Cannot build spreadsheet: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, buffer);
    } catch (error) {
      return fail(`Cannot write file: ${error instanceof Error ? error.message : String(error)}`);
    }
    const cells = prepared.reduce((sum, sheet) => sum + sheet.rows.length * sheet.rows[0].length, 0);
    return {
      success: true,
      output: `Spreadsheet created: ${resolved} (${prepared.length} sheets, ${cells} cells).`,
      sheets: prepared.length,
      cells,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
