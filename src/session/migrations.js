// src/session/migrations.js
//
// Versioned SQLite migrations (better-sqlite3 is synchronous, so the whole
// runner is sync — no half-applied states from interleaved awaits).
//
// Each migration is guarded (IF NOT EXISTS / column checks) so it is safe to
// run on fresh databases AND on databases created by older nano versions
// that applied the same changes ad hoc. The applied version is stored in
// PRAGMA user_version; only pending migrations run, inside one transaction.

export const SCHEMA_VERSION = 5;

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
  {
    version: 4,
    name: "session channel identity, turn idempotency, model and usage",
    apply(db) {
      const sessionColumns = [
        ["channel", "TEXT"],
        ["external_ref", "TEXT"],
        ["parent_session_id", "TEXT"],
        ["kind", "TEXT NOT NULL DEFAULT 'chat'"],
        ["model", "TEXT"],
      ];
      for (const [column, type] of sessionColumns) {
        if (!hasColumn(db, "session", column)) {
          db.exec(`ALTER TABLE session ADD COLUMN ${column} ${type}`);
        }
      }

      const turnColumns = [
        ["client_message_id", "TEXT"],
        ["provider", "TEXT"],
        ["model", "TEXT"],
        ["usage", "TEXT"],
      ];
      for (const [column, type] of turnColumns) {
        if (!hasColumn(db, "turn", column)) {
          db.exec(`ALTER TABLE turn ADD COLUMN ${column} ${type}`);
        }
      }

      // A channel mapping and a client retry are both unique identities. The
      // partial indexes deliberately ignore NULL so legacy rows stay valid.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_session_channel_external
          ON session(channel, external_ref)
          WHERE external_ref IS NOT NULL;
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_client_message
          ON turn(session_id, client_message_id)
          WHERE client_message_id IS NOT NULL;
      `);
    },
  },
  {
    version: 5,
    name: "durable background jobs and job notifications",
    apply(db) {
      const turnColumns = [
        ["kind", "TEXT NOT NULL DEFAULT 'chat'"],
        ["trigger_ref", "TEXT"],
      ];
      for (const [column, type] of turnColumns) {
        if (!hasColumn(db, "turn", column)) {
          db.exec(`ALTER TABLE turn ADD COLUMN ${column} ${type}`);
        }
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS job (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          name TEXT,
          command TEXT NOT NULL,
          cwd TEXT NOT NULL,
          shell TEXT NOT NULL,
          notify TEXT NOT NULL DEFAULT 'always',
          timeout_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          runner_pid INTEGER,
          child_pid INTEGER,
          output_path TEXT NOT NULL,
          result_path TEXT NOT NULL,
          exit_code INTEGER,
          signal TEXT,
          timed_out INTEGER NOT NULL DEFAULT 0,
          truncated INTEGER NOT NULL DEFAULT 0,
          output_bytes INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at DATETIME DEFAULT (datetime('now','localtime')),
          started_at DATETIME,
          finished_at DATETIME,
          updated_at DATETIME DEFAULT (datetime('now','localtime'))
        );
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_job_session ON job(session_id, created_at DESC);`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_job_status ON job(status, created_at);`,
      );

      // One notification row per job is the first dedupe guard; the unique
      // turn(session_id, client_message_id) index is the second.
      db.exec(`
        CREATE TABLE IF NOT EXISTS job_notification (
          job_id TEXT PRIMARY KEY REFERENCES job(id) ON DELETE CASCADE,
          state TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at DATETIME DEFAULT (datetime('now','localtime')),
          updated_at DATETIME DEFAULT (datetime('now','localtime')),
          delivered_at DATETIME
        );
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_job_notification_state
           ON job_notification(state, updated_at);`,
      );
      // Very old databases can predate turn.created_at (v1 used IF NOT EXISTS
      // for the whole table, so an ad-hoc legacy table survived). The index
      // needs the column; backfill-compatible ALTER cannot use a non-constant
      // default, so legacy rows simply keep NULL and are excluded by the
      // one-hour job-turn query.
      if (!hasColumn(db, "turn", "created_at")) {
        db.exec("ALTER TABLE turn ADD COLUMN created_at DATETIME");
      }
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_turn_kind_session
           ON turn(session_id, kind, created_at);`,
      );
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
