// gateway/service/audit-service.js

import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import { STORAGE_DIR } from "../../src/session/sql.js";

const AUDIT_PATH = path.join(STORAGE_DIR, "audit.log");

// Unbounded logs kill 24/7 disks quietly: rotate past 5MB, keep 3 files.
const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
const KEEP_ROTATED = 3;
let writesSinceRotationCheck = 0;

/**
 * Rotate a log file when oversized (oldest dropped first). Exported for
 * unit tests; production calls it through writeEntry on a sampling basis.
 */
export function rotateLogFile(auditPath, maxBytes = MAX_AUDIT_BYTES, keep = KEEP_ROTATED) {
  let size = 0;
  try {
    size = syncFs.statSync(auditPath).size;
  } catch {
    return { rotated: false };
  }
  if (size <= maxBytes) return { rotated: false };
  try {
    for (let index = keep - 1; index >= 1; index--) {
      const older = `${auditPath}.${index}`;
      const newer = `${auditPath}.${index + 1}`;
      if (syncFs.statSync(older, { throwIfNoEntry: false })) {
        syncFs.renameSync(older, newer);
      }
    }
    syncFs.renameSync(auditPath, `${auditPath}.1`);
    try {
      syncFs.rmSync(`${auditPath}.${keep + 1}`, { force: true });
    } catch {
      // Stray overflow file; best effort only.
    }
    return { rotated: true };
  } catch {
    return { rotated: false };
  }
}

/**
 * Build one audit entry. Prompt and tool contents are intentionally left
 * out: metadata is enough for operations, contents may carry secrets.
 */
export function buildEntry(req, res, durationMs) {
  const entry = {
    ts: new Date().toISOString(),
    ip: req.ip,
    method: req.method,
    path: req.path,
    status: res.statusCode,
    ms: Math.round(durationMs),
  };

  const sessionId =
    req.body?.session_id ?? req.params?.session_id ?? undefined;
  if (typeof sessionId === "string" && sessionId.length > 0) {
    entry.session_id = sessionId;
  }

  if (typeof req.body?.name === "string" && req.body.name.length > 0) {
    entry.agent = req.body.name;
  }

  return entry;
}

export async function writeEntry(entry) {
  try {
    await fs.appendFile(AUDIT_PATH, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (error) {
    console.error("[audit] Failed to write audit entry:", error.message);
    return;
  }
  // A stat per request would tax the hot path; sample the rotation check.
  writesSinceRotationCheck++;
  if (writesSinceRotationCheck >= 100) {
    writesSinceRotationCheck = 0;
    try {
      rotateLogFile(AUDIT_PATH);
    } catch {
      // Rotation must never break request handling.
    }
  }
}
