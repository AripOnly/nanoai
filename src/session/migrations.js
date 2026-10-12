// src/session/migrations.js
//
// Versioned SQLite migrations (better-sqlite3 is synchronous, so the whole
// runner is sync — no half-applied states from interleaved awaits).
//
// Each migration is guarded (IF NOT EXISTS / column checks) so it is safe to
// run on fresh databases AND on databases created by older nano versions
// that applied the same changes ad hoc. The applied version is stored in
// PRAGMA user_version; only pending migrations run, inside one transaction.

export const SCHEMA_VERSION = 3;

const hasColumn = (db, table, column) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((info) => info.name === column);

const MIGRATIONS = [
  {
    version: 1,
    name: "base session and turn tables",
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at DATETIME DEFAULT (datetime('now','localtime')),
          updated_at DATETIME DEFAULT (datetime('now','localtime'))
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS turn (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parts TEXT NOT NULL,
          session_id TEXT REFERENCES session(id) ON DELETE CASCADE,
          created_at DATETIME DEFAULT (datetime('now','localtime'))
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_session ON turn(session_id);`);
    },
  },
  {
    version: 2,
    name: "session summary, token and initial prompt columns",
    apply(db) {
      if (!hasColumn(db, "session", "summary")) {
        db.exec("ALTER TABLE session ADD COLUMN summary TEXT");
      }
      if (!hasColumn(db, "session", "token")) {
        db.exec("ALTER TABLE session ADD COLUMN token INTEGER");
      }
      if (!hasColumn(db, "session", "initial_prompt")) {
        db.exec("ALTER TABLE session ADD COLUMN initial_prompt TEXT");
      }
    },
  },
  {
    version: 3,
    name: "turn status column for interrupted-turn recovery",
    apply(db) {
      if (!hasColumn(db, "turn", "status")) {
        db.exec("ALTER TABLE turn ADD COLUMN status TEXT DEFAULT 'complete'");
      }
    },
  },
];

/**
 * Bring any nano database to SCHEMA_VERSION. Returns the list of applied
 * migration versions (empty when already current).
 */
export function migrate(db) {
  if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function") {
    throw new Error("migrate() requires a better-sqlite3 database instance.");
  }
  const row = db.prepare("PRAGMA user_version").get();
  const current = Number(row?.user_version ?? 0);
  if (!Number.isInteger(current) || current < 0) {
    throw new Error("Database user_version is corrupt. Restore from a backup.");
  }
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this nanoai build (max ${SCHEMA_VERSION}). Update nanoai first.`,
    );
  }
  const applied = [];
  const run = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      migration.apply(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      applied.push(migration.version);
    }
  });
  run();
  return applied;
}
