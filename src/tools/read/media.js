// src/tools/read/media.js
//
// Media sniffing for the read tool. Detection order: magic bytes first,
// file extension second, content heuristic last.
//
// Attachment *storage* lives in shared/attachments.js (used by read, webfetch
// and the LLM provider); this module only classifies bytes, so read-side
// changes can never break other tools again.

import path from "node:path";

// Extensions refused without further inspection. Note: .xls is intentionally
// absent (legacy spreadsheets are parsed by excel.js); .doc/.ppt stay here
// because no parser handles binary OLE documents.
const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar", ".war", ".7z",
  ".doc", ".ppt", ".bin", ".dat", ".obj", ".o", ".a", ".lib",
  ".wasm", ".pyc", ".pyo",
]);

// Office formats handled by dedicated parsers (word.js / excel.js).
export const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".xls"]);

function hasPrefix(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Identify image/PDF content from magic bytes. Returns the MIME type or null
 * when the bytes are not a recognized media format.
 */
export function sniffMediaMime(sample) {
  if (hasPrefix(sample, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasPrefix(sample, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  const head = sample.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (
    sample.length >= 12 &&
    sample.subarray(0, 4).toString("latin1") === "RIFF" &&
    sample.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (hasPrefix(sample, [0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  return null;
}

/**
 * Decide whether a file is binary. Extension blocklist first (cheap),
 * then content heuristic on the sample: any NUL byte, or more than 30%
 * non-printable bytes (0.3 threshold).
 */
export function isBinaryFile(filePath, sample) {
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return true;
  if (sample.length === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i];
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++;
  }
  return nonPrintable / sample.length > 0.3;
}

