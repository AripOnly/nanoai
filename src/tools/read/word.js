// src/tools/read/word.js
//
// Word document (.docx) to text via mammoth, the production-standard
// .docx-to-text library (semantic HTML/raw text, pure JS, no native deps).
// Legacy binary .doc (OLE) is refused with guidance: parsing it needs heavy
// legacy tooling that does not belong in this agent.

import mammoth from "mammoth";

const MAX_WORD_CHARS = 100 * 1024;

export function isWordFile(filePath) {
  return filePath.toLowerCase().endsWith(".docx");
}

/**
 * Extract readable text from a .docx buffer. Returns { text, truncated }.
 * Tables are flattened row by row; formatting is intentionally dropped
 * because the consumer is an LLM, not a renderer.
 */
export async function readWordDocument(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Cannot read an empty Word document.");
  }
  let result;
  try {
    result = await mammoth.extractRawText({ buffer });
  } catch (error) {
    throw new Error(
      `Cannot parse Word document: ${error instanceof Error ? error.message : String(error)}. ` +
        "The file may be corrupt or password-protected.",
    );
  }
  const text = (result.value ?? "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) {
    return { text: "(Word document contains no readable text.)", truncated: false };
  }
  if (text.length > MAX_WORD_CHARS) {
    return { text: text.slice(0, MAX_WORD_CHARS), truncated: true };
  }
  return { text, truncated: false };
}
