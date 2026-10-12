// scripts/restore.mjs
//
// Restore memories.db from a backup file. Safety first:
//   1. Refuses while the gateway holds the database (best-effort port probe).
//   2. Backs up the current database before replacing it.
//   3. Validates the backup (integrity + schema version) before touching live data.
//   4. Drops stale WAL sidecars so the restored file opens cleanly.
//
// Usage: node scripts/restore.mjs <backup-file> [--force]

import Database from "better-sqlite3";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "#src/shared/data-dir.js";

function checkIntegrity(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("PRAGMA integrity_check").get();
    if (!row || row.integrity_check !== "ok") {
      throw new Error(`Backup integrity check failed: ${row?.integrity_check ?? "unknown error"}.`);
    }
    const version = db.prepare("PRAGMA user_version").get();
    return Number(version?.user_version ?? 0);
  } finally {
    db.close();
  }
}

function isGatewayRunning(port = 3060, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * Restore dbPath from backupFile. Set force=true only to skip the
 * gateway-running refusal (tests). Always returns the pre-restore backup path.
 */
export async function restoreDatabase({ dbPath, backupFile, backupsDir, force = false, gatewayPort = 3060 }) {
  if (typeof backupFile !== "string" || backupFile === "") {
    throw new Error("backupFile must be a non-empty string.");
  }
  const resolvedBackup = path.resolve(backupFile);
  if (!fs.statSync(resolvedBackup, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Backup file not found: ${backupFile}`);
  }
  if (!force && (await isGatewayRunning(gatewayPort))) {
    throw new Error(
      `Refusing restore: the gateway is running on port ${gatewayPort}. Stop it first (its open database would be clobbered).`,
    );
  }

  const { SCHEMA_VERSION } = await import("#src/session/migrations.js");
  const foundVersion = checkIntegrity(resolvedBackup);
  if (foundVersion > SCHEMA_VERSION) {
    throw new Error(
      `Backup schema version ${foundVersion} is newer than this nano build (max ${SCHEMA_VERSION}). Update nano first.`,
    );
  }

  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const preRestore = path.join(backupsDir, `pre-restore-${stamp}.db`);
  if (fs.statSync(dbPath, { throwIfNoEntry: false })?.isFile()) {
    fs.copyFileSync(dbPath, preRestore);
  }
  fs.copyFileSync(resolvedBackup, dbPath);
  // A copied main file with someone else's WAL would open inconsistently.
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.rmSync(sidecar, { force: true });
    } catch {
      // Best effort only.
    }
  }
  return { restored: dbPath, preRestore: fs.existsSync(preRestore) ? preRestore : null };
}

async function main() {
  const [backupFile, ...rest] = process.argv.slice(2);
  if (!backupFile || backupFile.startsWith("--")) {
    console.error("Usage: node scripts/restore.mjs <backup-file> [--force]");
    process.exitCode = 1;
    return;
  }
  const storageDir = dataDir();
  const result = await restoreDatabase({
    dbPath: path.join(storageDir, "memories.db"),
    backupFile,
    backupsDir: path.join(storageDir, "backups"),
    force: rest.includes("--force"),
  });
  console.log(`Restored memories.db from ${backupFile}`);
  if (result.preRestore) console.log(`Previous database backed up to ${result.preRestore}`);
  console.log("Start the gateway to apply any pending migrations.");
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) {
  main().catch((error) => {
    console.error(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
