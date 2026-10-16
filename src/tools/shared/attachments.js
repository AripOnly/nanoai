// src/tools/shared/attachments.js
//
// Shared attachment store: images and PDFs are persisted by reference under
// the per-user data dir (~/.nanoai/attachments) and sent to the LLM exactly
// once (see google.js).
// Raw bytes never enter session history, keeping the database small and
// preventing repeat token charges on later turns.
//
// Lives in shared/ because three layers depend on it (read, webfetch, and
// the LLM provider). Depending on a sibling tool folder instead (as before)
// hid the coupling and rotted on every read-side change.

import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "#src/shared/data-dir.js";

export const ATTACH_DIR = path.join(dataDir(), "attachments");

// Conservative per-file cap: the Gemini inline limit is 20MB. Larger files
// are refused with guidance instead of failing obscurely at the API.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// Best-effort 7-day retention for the attachment cache.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Image types the model accepts inline.
export const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function extensionForMime(mime) {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "application/pdf") return ".pdf";
  return ".bin";
}

async function cleanupOldAttachments() {
  let entries;
  try {
    entries = fs.readdirSync(ATTACH_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - RETENTION_MS;
  for (const entry of entries) {
    if (!/^[A-Za-z0-9_-]+\.[a-z0-9]+$/i.test(entry)) continue;
    const file = path.join(ATTACH_DIR, entry);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch {
      // One stale file must never break a read.
    }
  }
}

/**
 * Persist attachment bytes and return a small reference. Callers embed the
 * reference (never the bytes) in tool results and history.
 */
export async function saveAttachment(bytes, mime) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error("Cannot attach empty content.");
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `File is too large to attach (${(bytes.length / 1024 / 1024).toFixed(1)} MB, limit 10 MB). ` +
        "Extract the needed part first, or ask the user for a smaller file.",
    );
  }
  await mkdir(ATTACH_DIR, { recursive: true });
  const id = randomUUID().replaceAll("-", "");
  const file = path.join(ATTACH_DIR, id + extensionForMime(mime));
  await writeFile(file, bytes);
  cleanupOldAttachments().catch(() => {});
  return { id, mime, size: bytes.length };
}

/**
 * Load attachment bytes by reference id. The strict id pattern prevents
 * path traversal: only files created by saveAttachment are reachable.
 */
export function loadAttachment(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    throw new Error(`Unknown attachment: ${String(id).slice(0, 40)}`);
  }
  const entry = fs.readdirSync(ATTACH_DIR).find((name) => name.startsWith(id));
  if (!entry) {
    throw new Error("Attachment expired or not found. Read the file again to re-attach it.");
  }
  return fs.readFileSync(path.join(ATTACH_DIR, entry));
}

export function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
