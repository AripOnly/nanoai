// src/session/sql.js

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { dataDir, migrateLegacyData } from "#src/shared/data-dir.js";
import { SCHEMA_VERSION, migrate } from "./migrations.js";
import { backupBeforeMigration } from "./migration-backup.js";

// Per-user storage so the gateway works no matter which directory it is
// started from — and survives global npm installs (the package folder itself
// may be read-only). Legacy repo-relative storage/ is adopted once, below.
migrateLegacyData();
const STORAGE_DIR = dataDir();
fs.mkdirSync(STORAGE_DIR, { recursive: true });

export { STORAGE_DIR, SCHEMA_VERSION };

const dbPath = path.join(STORAGE_DIR, "memories.db");
const sql = new Database(dbPath);
sql.pragma("journal_mode = WAL");
sql.pragma("foreign_keys = ON");

// Never migrate an existing database without a recoverable copy. A brand-new
// empty file has nothing to protect, so it skips the backup.
const currentVersion = Number(
  sql.prepare("PRAGMA user_version").get()?.user_version ?? 0,
);
const hasSessionTable = sql
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session'")
  .get();
const hasUserData =
  hasSessionTable !== undefined &&
  Number(sql.prepare("SELECT COUNT(*) AS count FROM session").get()?.count ?? 0) >
    0;
if (
  currentVersion < SCHEMA_VERSION &&
  (currentVersion > 0 || hasUserData)
) {
  await backupBeforeMigration(sql, {
    dbPath,
    fromVersion: currentVersion,
    toVersion: SCHEMA_VERSION,
  });
}

// Schema upgrades run here at boot, before any reader or writer touches data.
migrate(sql);

export function closeDatabase() {
  sql.close();
}

export default sql;
