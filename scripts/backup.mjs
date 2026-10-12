// scripts/backup.mjs
//
// Online SQLite backup with retention. Safe to run while the gateway is up:
// better-sqlite3 streams a consistent snapshot without locking writers out.
//
// Usage: node scripts/backup.mjs [--keep N]  (default keep: 7 newest)

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "#src/shared/data-dir.js";

export const DEFAULT_KEEP = 7;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function listBackups(backupsDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(backupsDir).filter((name) => /^nanoai-\d{8}-\d{6}\.db$/.test(name));
  } catch {
    entries = [];
  }
  return entries.sort().map((name) => path.join(backupsDir, name));
}

export function pruneBackups(backupsDir, keep = DEFAULT_KEEP) {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error("keep must be a positive integer.");
  }
  const files = listBackups(backupsDir);
  const stale = files.slice(0, Math.max(0, files.length - keep));
  for (const file of stale) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // One stale backup must never fail the whole run.
    }
  }
  return { kept: files.length - stale.length, removed: stale.length };
}

/**
 * Copy a live database file to a timestamped backup. Never opens the source
 * with the shared sql module (no migrations, no WAL side effects).
 */
export async function backupDatabase(dbPath, backupsDir, keep = DEFAULT_KEEP) {
  if (typeof dbPath !== "string" || dbPath === "") {
    throw new Error("dbPath must be a non-empty string.");
  }
  if (!fs.statSync(dbPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Database file not found: ${dbPath}`);
  }
  fs.mkdirSync(backupsDir, { recursive: true });
  const dest = path.join(backupsDir, `nanoai-${timestamp()}.db`);
  const source = new Database(dbPath, { readonly: true });
  try {
    await source.backup(dest);
  } finally {
    source.close();
  }
  const pruned = pruneBackups(backupsDir, keep);
  return { dest, ...pruned };
}

async function main() {
  const keepArg = process.argv.find((arg) => arg.startsWith("--keep="));
  const keep = keepArg ? Number.parseInt(keepArg.slice("--keep=".length), 10) : DEFAULT_KEEP;
  if (!Number.isInteger(keep) || keep < 1) {
    console.error("Usage: node scripts/backup.mjs [--keep N]  (N is a positive integer)");
    process.exitCode = 1;
    return;
  }
  // Data-dir path computed locally: importing the shared sql module would
  // open (and migrate) the live database as a side effect of asking where
  // the file lives.
  const storageDir = dataDir();
  const result = await backupDatabase(path.join(storageDir, "memories.db"), path.join(storageDir, "backups"), keep);
  console.log(`Backup written: ${result.dest} (kept ${result.kept}, removed ${result.removed})`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) {
  main().catch((error) => {
    console.error(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
