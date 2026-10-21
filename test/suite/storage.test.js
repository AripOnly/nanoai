// test/suite/storage.test.js
// Covers versioned migrations (fresh and legacy databases) plus the
// backup/restore logic with throwaway databases — never the live one.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { SCHEMA_VERSION, migrate } from "../../src/session/migrations.js";
import {
  backupBeforeMigration,
  listMigrationBackups,
} from "../../src/session/migration-backup.js";
import { backupDatabase, pruneBackups } from "../../scripts/backup.mjs";
import { restoreDatabase } from "../../scripts/restore.mjs";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((info) => info.name);
}

describe("migrations", () => {
  it("builds the full schema from scratch and reports applied versions", () => {
    const db = new Database(":memory:");
    try {
      const applied = migrate(db);
      assert.deepEqual(applied, [1, 2, 3, 4]);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
      for (const column of [
        "id",
        "name",
        "summary",
        "token",
        "initial_prompt",
        "channel",
        "external_ref",
        "parent_session_id",
        "kind",
        "model",
      ]) {
        assert.ok(columns(db, "session").includes(column), `session.${column} missing`);
      }
      for (const column of [
        "id",
        "parts",
        "session_id",
        "status",
        "client_message_id",
        "provider",
        "model",
        "usage",
      ]) {
        assert.ok(columns(db, "turn").includes(column), `turn.${column} missing`);
      }
      const indexes = db
        .prepare("PRAGMA index_list('session')")
        .all()
        .map((row) => row.name);
      assert.ok(indexes.includes("idx_session_channel_external"));
      const turnIndexes = db
        .prepare("PRAGMA index_list('turn')")
        .all()
        .map((row) => row.name);
      assert.ok(turnIndexes.includes("idx_turn_client_message"));
    } finally {
      db.close();
    }
  });

  it("upgrades a legacy database without losing rows", () => {
    const db = new Database(":memory:");
    try {
      // Simulate a pre-migration database: base tables only, version 0.
      db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
      db.exec("CREATE TABLE turn (id INTEGER PRIMARY KEY AUTOINCREMENT, parts TEXT NOT NULL, session_id TEXT)");
      db.exec("INSERT INTO session (id, name) VALUES ('s1', 'legacy')");
      const applied = migrate(db);
      assert.deepEqual(applied, [1, 2, 3, 4]);
      assert.equal(db.prepare("SELECT name FROM session WHERE id = 's1'").get().name, "legacy");
      assert.ok(columns(db, "session").includes("token"));
      assert.ok(columns(db, "session").includes("channel"));
      assert.ok(columns(db, "turn").includes("status"));
      assert.ok(columns(db, "turn").includes("client_message_id"));
      // Second run is a no-op.
      assert.deepEqual(migrate(db), []);
    } finally {
      db.close();
    }
  });

  it("backs up a v3 database before applying v4", async () => {
    const dir = tempDir("nano-migrate-v4-");
    const dbPath = path.join(dir, "memories.db");
    const backups = path.join(dir, "backups");
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          summary TEXT,
          token INTEGER DEFAULT 0,
          initial_prompt TEXT,
          created_at DATETIME DEFAULT (datetime('now','localtime')),
          updated_at DATETIME DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE turn (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parts TEXT NOT NULL,
          session_id TEXT,
          status TEXT DEFAULT 'complete'
        );
        INSERT INTO session (id, name, token) VALUES ('s1', 'v3 legacy', 42);
        INSERT INTO turn (parts, session_id) VALUES ('[]', 's1');
        PRAGMA user_version = 3;
      `);

      const backupPath = await backupBeforeMigration(db, {
        dbPath,
        backupsDir: backups,
        fromVersion: 3,
        toVersion: 4,
      });
      assert.ok(fs.statSync(backupPath).isFile());

      const copy = new Database(backupPath, { readonly: true });
      try {
        assert.equal(
          copy.prepare("PRAGMA user_version").get().user_version,
          3,
        );
        assert.equal(
          copy.prepare("SELECT name FROM session WHERE id = 's1'").get().name,
          "v3 legacy",
        );
        assert.equal(copy.prepare("SELECT COUNT(*) AS count FROM turn").get().count, 1);
        assert.equal(
          columns(copy, "session").includes("channel"),
          false,
          "the backup must be a true pre-migration copy",
        );
      } finally {
        copy.close();
      }

      assert.deepEqual(migrate(db), [4]);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
      assert.equal(
        db.prepare("SELECT token FROM session WHERE id = 's1'").get().token,
        42,
      );
      assert.ok(columns(db, "session").includes("channel"));
      assert.ok(columns(db, "turn").includes("client_message_id"));
    } finally {
      db.close();
    }
  });

  it("backs up automatically when the session database migrates at boot", async () => {
    const dir = tempDir("nano-auto-migrate-");
    const dbPath = path.join(dir, "memories.db");
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          summary TEXT,
          token INTEGER DEFAULT 0,
          initial_prompt TEXT,
          created_at DATETIME DEFAULT (datetime('now','localtime')),
          updated_at DATETIME DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE turn (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parts TEXT NOT NULL,
          session_id TEXT,
          status TEXT DEFAULT 'complete'
        );
        INSERT INTO session (id, name, token) VALUES ('boot-1', 'boot legacy', 7);
        PRAGMA user_version = 3;
      `);
    } finally {
      db.close();
    }

    const sqlUrl = new URL("../../src/session/sql.js", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const door = await import(${JSON.stringify(sqlUrl)}); door.closeDatabase();`,
      ],
      {
        env: { ...process.env, NANO_DATA_DIR: dir },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);

    const backups = listMigrationBackups(path.join(dir, "backups"));
    assert.equal(backups.length, 1);
    const copy = new Database(backups[0], { readonly: true });
    try {
      assert.equal(copy.prepare("PRAGMA user_version").get().user_version, 3);
    } finally {
      copy.close();
    }

    const migrated = new Database(dbPath, { readonly: true });
    try {
      assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 4);
      assert.equal(
        migrated.prepare("SELECT token FROM session WHERE id = 'boot-1'").get()
          .token,
        7,
      );
      assert.ok(columns(migrated, "session").includes("channel"));
    } finally {
      migrated.close();
    }
  });

  it("rejects corrupt and future versions clearly", () => {
    const db = new Database(":memory:");
    try {
      assert.throws(() => migrate(null), /better-sqlite3/);
      db.exec("PRAGMA user_version = 999");
      assert.throws(() => migrate(db), /newer than this nanoai build/);
    } finally {
      db.close();
    }
  });
});

describe("backup and restore", () => {
  it("backs up a database and prunes old copies", async () => {
    const dir = tempDir("nano-backup-");
    const dbPath = path.join(dir, "memories.db");
    const backups = path.join(dir, "backups");
    const source = new Database(dbPath);
    try {
      source.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      source.exec("INSERT INTO t (v) VALUES ('hello')");
    } finally {
      source.close();
    }
    // Seed fake old backups to exercise retention.
    fs.mkdirSync(backups, { recursive: true });
    for (const name of ["nanoai-20200101-000000.db", "nanoai-20200102-000000.db"]) {
      fs.writeFileSync(path.join(backups, name), "stale");
    }
    const result = await backupDatabase(dbPath, backups, 2);
    assert.ok(fs.statSync(result.dest).isFile());
    assert.equal(result.kept, 2);
    assert.equal(result.removed, 1);
    const check = new Database(result.dest, { readonly: true });
    try {
      assert.equal(check.prepare("SELECT v FROM t").get().v, "hello");
    } finally {
      check.close();
    }
    await assert.rejects(backupDatabase(path.join(dir, "missing.db"), backups), /not found/);
    assert.throws(() => pruneBackups(backups, 0), /positive integer/);
  });

  it("restores only after validating and safeguarding", async () => {
    const dir = tempDir("nano-restore-");
    const live = path.join(dir, "memories.db");
    const backups = path.join(dir, "backups");
    fs.mkdirSync(backups, { recursive: true });
    const make = (file, value) => {
      const db = new Database(file);
      try {
        db.exec("CREATE TABLE t (v TEXT)");
        db.exec(`INSERT INTO t VALUES ('${value}')`);
      } finally {
        db.close();
      }
    };
    make(live, "current-data");
    const good = path.join(backups, "good.db");
    make(good, "backup-data");
    // force:true skips the gateway probe (no gateway in unit tests).
    const result = await restoreDatabase({ dbPath: live, backupFile: good, backupsDir: backups, force: true });
    assert.ok(result.preRestore && fs.existsSync(result.preRestore));
    const check = new Database(live, { readonly: true });
    try {
      assert.equal(check.prepare("SELECT v FROM t").get().v, "backup-data");
    } finally {
      check.close();
    }
    // Corrupt backups are refused before touching live data.
    const corrupt = path.join(backups, "corrupt.db");
    fs.writeFileSync(corrupt, "not a database at all");
    await assert.rejects(
      restoreDatabase({ dbPath: live, backupFile: corrupt, backupsDir: backups, force: true }),
      /integrity|not a database/i,
    );
    const still = new Database(live, { readonly: true });
    try {
      assert.equal(still.prepare("SELECT v FROM t").get().v, "backup-data");
    } finally {
      still.close();
    }
    await assert.rejects(
      restoreDatabase({ dbPath: live, backupFile: path.join(backups, "nope.db"), backupsDir: backups, force: true }),
      /not found/,
    );
  });
});
