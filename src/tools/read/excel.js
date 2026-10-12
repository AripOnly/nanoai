// src/tools/read/excel.js
//
// Spreadsheet (.xlsx/.xls) to text via SheetJS, the production-standard
// spreadsheet parser (20+ formats including legacy .xls, pure JS).
// Each sheet becomes a section of pipe-separated rows so the model can scan
// values without drowning in markup.

import XLSX from "xlsx";

const MAX_SHEETS = 20;
const MAX_ROWS_PER_SHEET = 500;
const MAX_CELL_CHARS = 500;

export function isSpreadsheetFile(filePath) {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".xlsx") || lower.endsWith(".xls");
}

function formatCell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  if (text.length > MAX_CELL_CHARS) return text.slice(0, MAX_CELL_CHARS) + "...";
  return text;
}

/**
 * Parse a workbook buffer into readable text. Returns
 * { text, truncated, sheets } where sheets counts parsed sheets.
 */
export function readSpreadsheet(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Cannot read an empty spreadsheet.");
  }
  // SheetJS is lenient and happily "parses" random bytes into junk sheets,
  // so verify the container magic first: PK zip for modern formats,
  // OLE header for legacy .xls.
  const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  const isOle =
    buffer.length >= 8 &&
    buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
  if (!isZip && !isOle) {
    throw new Error("Not a spreadsheet file: unrecognized format. The file may be corrupt or misnamed.");
  }
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer" });
  } catch (error) {
    throw new Error(
      `Cannot parse spreadsheet: ${error instanceof Error ? error.message : String(error)}. ` +
        "The file may be corrupt or password-protected.",
    );
  }
  const names = (workbook.SheetNames ?? []).slice(0, MAX_SHEETS);
  if (names.length === 0) {
    return { text: "(Spreadsheet contains no sheets.)", truncated: false, sheets: 0 };
  }
  let truncated = (workbook.SheetNames ?? []).length > MAX_SHEETS;
  const sections = [];
  for (const name of names) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
    if (rows.length === 0) {
      sections.push(`## Sheet: ${name} (empty)`);
      continue;
    }
    const shown = rows.slice(0, MAX_ROWS_PER_SHEET);
    if (rows.length > MAX_ROWS_PER_SHEET) truncated = true;
    const lines = shown.map((row) =>
      (Array.isArray(row) ? row : [row]).map(formatCell).join(" | "),
    );
    sections.push(`## Sheet: ${name} (${rows.length} rows)\n${lines.join("\n")}`);
  }
  const text = sections.join("\n\n");
  if (!text) {
    return { text: "(Spreadsheet contains no readable values.)", truncated, sheets: names.length };
  }
  return { text, truncated, sheets: names.length };
}
