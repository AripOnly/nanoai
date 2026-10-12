// src/shared/data-dir.js
//
// Per-user runtime data directory. The install location (repo checkout or the
// global npm folder) is read-only territory: the program lives there, but
// everything NanoAI writes at runtime (database, config, pidfile, logs,
// attachments, backups, cached binaries) lives in the user's home instead.
// Override with NANO_DATA_DIR (tests and portable installs use this).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/shared/ -> package root.
export const PACKAGE_ROOT = path.join(__dirname, "..", "..");

export const CONFIG_FILENAME = "nano.config.json";
const LEGACY_SETTINGS = path.join(PACKAGE_ROOT, "config", "settings.json");
const LEGACY_STORAGE = path.join(PACKAGE_ROOT, "storage");

/** Resolve the data directory, creating it on demand. */
export function dataDir() {
  const override = (process.env.NANO_DATA_DIR ?? "").trim();
  const dir = override !== "" ? path.resolve(override) : path.join(os.homedir(), ".nanoai");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Join path segments onto the data directory. */
export function dataPath(...parts) {
  return path.join(dataDir(), ...parts);
}

function moveFile(src, dest) {
  try {
    if (!fs.statSync(src, { throwIfNoEntry: false })?.isFile()) return false;
    if (fs.statSync(dest, { throwIfNoEntry: false })?.isFile()) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.renameSync(src, dest);
    } catch {
      // Cross-device move: copy then remove.
      fs.copyFileSync(src, dest);
      fs.rmSync(src, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}

function moveDirContents(srcDir, destDir) {
  let entries;
  try {
    entries = fs.readdirSync(srcDir);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  let moved = false;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry);
    const dest = path.join(destDir, entry);
    try {
      if (fs.statSync(dest, { throwIfNoEntry: false })) continue;
      fs.renameSync(src, dest);
      moved = true;
    } catch {
      // Leave it behind; the new location simply starts without it.
    }
  }
  return moved;
}

/**
 * One-time move of data created by older NanoAI layouts (repo-relative
 * storage/ and config/settings.json) into the per-user data directory.
 * Idempotent: only fills in targets that do not exist yet, so it is safe to
 * call on every boot. Never throws — a failed move must not block startup.
 * Skipped entirely when NANOAI_SKIP_MIGRATION is set (the test harness uses
 * throwaway data dirs and must never adopt or move real data).
 */
let migrationDone = false;
export function migrateLegacyData() {
  if (migrationDone) return { settings: false, storage: false, skipped: true };
  migrationDone = true;
  if ((process.env.NANOAI_SKIP_MIGRATION ?? "").trim() !== "") {
    return { settings: false, storage: false, skipped: true };
  }
  const moved = { settings: false, storage: false };
  try {
    moved.settings = moveFile(LEGACY_SETTINGS, path.join(dataDir(), CONFIG_FILENAME));
  } catch {
    // Best effort only.
  }
  try {
    moved.storage = moveDirContents(LEGACY_STORAGE, dataDir());
  } catch {
    // Best effort only.
  }
  return moved;
}
