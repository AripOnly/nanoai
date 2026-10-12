// src/session/sql.js

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { dataDir, migrateLegacyData } from "#src/shared/data-dir.js";
import { SCHEMA_VERSION, migrate } from "./migrations.js";

// Per-user storage so the gateway works no matter which directory it is
// started from — and survives global npm installs (the package folder itself
// may be read-only). Legacy repo-relative storage/ is adopted once, below.
migrateLegacyData();
const STORAGE_DIR = dataDir();
fs.mkdirSync(STORAGE_DIR, { recursive: true });

export { STORAGE_DIR, SCHEMA_VERSION };

const sql = new Database(path.join(STORAGE_DIR, "memories.db"));
sql.pragma("journal_mode = WAL");
sql.pragma("foreign_keys = ON");

// Schema upgrades run here at boot, before any reader or writer touches data.
migrate(sql);

export function closeDatabase() {
  sql.close();
}

export default sql;
