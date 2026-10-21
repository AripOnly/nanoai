// src/session/migration-backup.js
//
// A schema migration is the one operation that cannot be safely rolled back
// after the fact. Before the session database leaves a known older version we
// take a consistent SQLite online backup into the data directory's backups/
// folder. The copy is made through better-sqlite3's backup API so a live WAL
// is included without copying sidecar files by hand.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const MIGRATION_BACKUP_KEEP = 7;
const BACKUP_PATTERN = /^pre-v\d+(?:-from-v\d+)?-\d{8}-\d{9}\.db$/;

function timestamp() {
  const d = new Date();
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

export function listMigrationBackups(backupsDir) {
  try {
    return fs
      .readdirSync(backupsDir)
      .filter((name) => BACKUP_PATTERN.test(name))
      .sort()
      .map((name) => path.join(backupsDir, name));
  } catch {
    return [];
  }
}

export function pruneMigrationBackups(
  backupsDir,
  keep = MIGRATION_BACKUP_KEEP,
) {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error("keep must be a positive integer.");
  }
  const files = listMigrationBackups(backupsDir);
  const stale = files.slice(0, Math.max(0, files.length - keep));
  for (const file of stale) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Retention is best effort; the newest backup is what matters.
    }
  }
  return { kept: files.length - stale.length, removed: stale.length };
}

/**
 * Back up a database before applying a schema migration.
 *
 * @param {object} db better-sqlite3 database handle (already open)
 * @param {object} options
 * @param {string} options.dbPath live database path
 * @param {string} [options.backupsDir] destination (default: sibling backups/)
 * @param {number} [options.fromVersion]
 * @param {number} options.toVersion
 * @param {number} [options.keep]
 * @returns {Promise<string>} path of the new backup
 */
export async function backupBeforeMigration(
  db,
  {
    dbPath,
    backupsDir,
    fromVersion = null,
    toVersion,
    keep = MIGRATION_BACKUP_KEEP,
  } = {},
) {
  if (!db || typeof db.backup !== "function") {
    throw new Error(
      "backupBeforeMigration() requires an open better-sqlite3 database.",
    );
  }
  if (typeof dbPath !== "string" || dbPath.trim() === "") {
    throw new Error("dbPath must be a non-empty string.");
  }
  if (!Number.isInteger(toVersion) || toVersion < 1) {
    throw new Error("toVersion must be a positive integer.");
  }

  const destinationDir =
    backupsDir ?? path.join(path.dirname(path.resolve(dbPath)), "backups");
  await fsp.mkdir(destinationDir, { recursive: true });

  const label = Number.isInteger(fromVersion) ? `-from-v${fromVersion}` : "";
  const destination = path.join(
    destinationDir,
    `pre-v${toVersion}${label}-${timestamp()}.db`,
  );

  await db.backup(destination);
  pruneMigrationBackups(destinationDir, keep);
  return destination;
}
