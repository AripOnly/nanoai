// src/jobs/notify.js
//
// Notification policy and bounded log reads. Persistence lives in
// src/session/job-store.js; the auto-continue turn itself lives in
// src/runtime/job-notice.js. This module is the shared middle: it decides
// whether a terminal job deserves a notice and formats a small tail.

import fs from "node:fs/promises";
import {
  MAX_JOB_NOTICE_BYTES,
  MAX_JOB_NOTICE_LINES,
  formatJobNotice,
  isNoticeExpired,
  shouldNotify,
} from "./policy.js";

export { formatJobNotice, isNoticeExpired, shouldNotify };
export const MAX_NOTIFICATION_ATTEMPTS = 3;
export const DEFAULT_LOG_TAIL_BYTES = 8192;
export const DEFAULT_LOG_TAIL_LINES = 60;
export const MAX_LOG_READ_BYTES = 64 * 1024;

/** Last bytes of a file, with an optional line cap. Never loads the whole log. */
export async function readTail(
  filePath,
  {
    maxBytes = DEFAULT_LOG_TAIL_BYTES,
    maxLines = DEFAULT_LOG_TAIL_LINES,
  } = {},
) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return { text: "", bytes: 0, size: 0, truncated: false };
  }
  const byteLimit = Math.max(
    1,
    Math.min(Number.isInteger(maxBytes) ? maxBytes : MAX_JOB_NOTICE_BYTES, MAX_LOG_READ_BYTES),
  );
  let handle;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size === 0) {
      return { text: "", bytes: 0, size: stat.size, truncated: false };
    }
    const start = Math.max(0, stat.size - byteLimit);
    const length = stat.size - start;
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    if (Number.isInteger(maxLines) && maxLines > 0) {
      const lines = text.split(/\r?\n/);
      if (lines.length > maxLines) {
        text = `${lines.slice(-maxLines).join("\n")}`;
      }
    }
    return {
      text,
      bytes: Buffer.byteLength(text),
      size: stat.size,
      truncated: start > 0,
    };
  } catch {
    return { text: "", bytes: 0, size: 0, truncated: false };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Bounded range read backing process.log. */
export async function readLogRange(
  filePath,
  {
    offsetBytes = null,
    limitBytes = DEFAULT_LOG_TAIL_BYTES,
    tailLines = null,
  } = {},
) {
  const limit = Math.max(
    1,
    Math.min(
      Number.isInteger(limitBytes) ? limitBytes : DEFAULT_LOG_TAIL_BYTES,
      MAX_LOG_READ_BYTES,
    ),
  );
  let handle;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return { text: "", offsetBytes: 0, bytesRead: 0, size: 0, hasMore: false };
    }
    let start =
      Number.isInteger(offsetBytes) && offsetBytes >= 0
        ? Math.min(offsetBytes, stat.size)
        : Math.max(0, stat.size - limit);
    const length = Math.min(limit, Math.max(0, stat.size - start));
    if (length === 0) {
      return {
        text: "",
        offsetBytes: start,
        bytesRead: 0,
        size: stat.size,
        hasMore: start < stat.size,
      };
    }
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (Number.isInteger(tailLines) && tailLines > 0) {
      const lines = text.split(/\r?\n/);
      if (lines.length > tailLines) {
        text = lines.slice(-tailLines).join("\n");
      }
    }
    return {
      text,
      offsetBytes: start,
      bytesRead: Buffer.byteLength(text),
      size: stat.size,
      hasMore: start + length < stat.size || start > 0,
    };
  } catch {
    return {
      text: "",
      offsetBytes: 0,
      bytesRead: 0,
      size: 0,
      hasMore: false,
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Read a bounded tail and build the single notice text for a job turn. */
export async function noticeForJob(job, options = {}) {
  const logPath = job.logPath ?? job.output_path ?? job.outputPath;
  const tail = await readTail(logPath, options);
  return {
    text: formatJobNotice(job, { tail: tail.text }),
    tail,
  };
}

/** Deterministic backoff for pending notices; capped so boot never thunders. */
export function notificationRetryDelay(attempts = 1) {
  const safe = Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
  return Math.min(60_000, 1000 * 4 ** (safe - 1));
}
