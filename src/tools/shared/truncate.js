// src/tools/truncate.js
// Shared truncation helper, ported from opencode's truncate + shell tail logic.
// Moved here from src/tools/shell/truncate.js so all tools can reuse it.
// Opencode is read-only reference, this file is the nano implementation.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const MAX_METADATA_LENGTH = 30_000;

export function limits() {
  return {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  };
}

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Keep the last part of the output (tail), UTF-8 safe.
 * Port of opencode packages/opencode/src/tool/shell.ts tail().
 */
export function tail(text, maxLines, maxBytes) {
  const resolvedLines = maxLines ?? DEFAULT_MAX_LINES;
  const resolvedBytes = maxBytes ?? DEFAULT_MAX_BYTES;
  const lines = text.split("\n");

  if (
    lines.length <= resolvedLines &&
    byteLength(text) <= resolvedBytes
  ) {
    return { text, truncated: false, cut: false };
  }

  const out = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < resolvedLines; i--) {
    const size = byteLength(lines[i]) + (out.length > 0 ? 1 : 0);
    if (bytes + size > resolvedBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8");
        let start = buf.length - resolvedBytes;
        if (start < 0) start = 0;
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
        out.unshift(buf.subarray(start).toString("utf-8"));
      }
      break;
    }
    out.unshift(lines[i]);
    bytes += size;
  }

  return { text: out.join("\n"), truncated: true, cut: true };
}

/**
 * Live preview for streaming UI, keeps last MAX_METADATA_LENGTH chars.
 * Port of opencode shell.ts preview().
 */
export function preview(text) {
  if (text.length <= MAX_METADATA_LENGTH) return text;
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH);
}

async function saveOutput(text) {
  const directory = path.join(os.tmpdir(), "nano-shell");
  await mkdir(directory, { recursive: true });
  const filename = `shell-${Date.now()}-${Math.random().toString(36).slice(2)}.log`;
  const filePath = path.join(directory, filename);
  await writeFile(filePath, text, "utf8");
  return filePath;
}

export async function writeTruncation(text) {
  return saveOutput(text);
}

/**
 * Truncate command output while preserving the complete output on disk.
 * Keeps nano's { output, truncated, outputPath } shape.
 */
export async function truncateOutput(text, options = {}) {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  if (typeof text !== "string") {
    throw new Error("Output must be a string.");
  }
  if (!Number.isInteger(maxLines) || maxLines <= 0) {
    throw new Error("maxLines must be a positive integer.");
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive integer.");
  }

  const result = tail(text, maxLines, maxBytes);
  if (!result.truncated) {
    return { output: text, truncated: false, outputPath: null };
  }

  const outputPath = await saveOutput(text);
  return {
    output:
      "...output truncated...\n\n" +
      `Full output saved to: ${outputPath}\n\n` +
      result.text,
    truncated: true,
    outputPath,
  };
}
