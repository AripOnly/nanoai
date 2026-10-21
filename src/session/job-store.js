// src/session/job-store.js
//
// SQLite metadata for durable background jobs. This is the only module that
// writes job rows; the detached runner never imports it (or anything else in
// this folder) and communicates only through spec/result/pid/log files.
//
// Two identities make auto-continue exactly-once:
// - job_notification.job_id is a primary key (one notice per job);
// - turn(session_id, client_message_id) is unique with client_message_id
//   "job:<job_id>" (one notice turn per job).

import { randomUUID } from "node:crypto";
import sql from "./sql.js";

export const ACTIVE_JOB_STATUSES = Object.freeze(["starting", "running"]);
export const TERMINAL_JOB_STATUSES = Object.freeze([
  "completed",
  "failed",
  "killed",
  "lost",
]);
export const JOB_NOTIFY_POLICIES = Object.freeze([
  "always",
  "failure",
  "never",
]);

const ACTIVE_SQL = `('starting','running')`;
const TERMINAL_SQL = `('completed','failed','killed','lost')`;
const MAX_NOTIFICATION_ATTEMPTS = 3;

export class JobLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "JobLimitError";
    this.code = "JOB_LIMIT";
  }
}

function requireText(value, field, max = 4096) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new Error(`${field} must be at most ${max} characters.`);
  }
  return trimmed;
}

function optionalText(value, field, max = 4096) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) {
    throw new Error(`${field} must be at most ${max} characters.`);
  }
  return trimmed;
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function parseJob(row) {
  if (!row) return undefined;
  return {
    ...row,
    timed_out: row.timed_out === 1 || row.timed_out === true,
    truncated: row.truncated === 1 || row.truncated === true,
  };
}

function parseNotification(row) {
  if (!row) return undefined;
  return { ...row };
}

export function newJobId() {
  return `job_${randomUUID()}`;
}

class JobStore {
  /**
   * Insert a job while enforcing both limits in one synchronous transaction,
   * so two concurrent tool calls cannot both pass the count and overflow.
   */
  createJob(fields, { maxRunning = 4, maxPerSession = 2 } = {}) {
    const id = fields.id ?? newJobId();
    const sessionId = requireText(fields.sessionId ?? fields.session_id, "session_id");
    const command = requireText(fields.command, "command", 100_000);
    const cwd = requireText(fields.cwd, "cwd");
    const shell = requireText(fields.shell, "shell");
    const notify = fields.notify ?? "always";
    if (!JOB_NOTIFY_POLICIES.includes(notify)) {
      throw new Error(`notify must be one of: ${JOB_NOTIFY_POLICIES.join(", ")}.`);
    }
    const timeoutMs = positiveInteger(fields.timeoutMs ?? fields.timeout_ms, "timeout_ms");
    const outputPath = requireText(
      fields.outputPath ?? fields.output_path,
      "output_path",
    );
    const resultPath = requireText(
      fields.resultPath ?? fields.result_path,
      "result_path",
    );
    const name = optionalText(fields.name, "name", 200);
    const status = fields.status ?? "starting";

    const insert = sql.prepare(`
      INSERT INTO job
        (id, session_id, name, command, cwd, shell, notify, timeout_ms,
         status, runner_pid, child_pid, output_path, result_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const run = sql.transaction(() => {
      const running = Number(
        sql
          .prepare(`SELECT COUNT(*) AS count FROM job WHERE status IN ${ACTIVE_SQL}`)
          .get().count ?? 0,
      );
      if (running >= maxRunning) {
        throw new JobLimitError(
          `Background job limit reached: ${running}/${maxRunning} jobs are active. Wait for one to finish before starting another.`,
        );
      }
      const perSession = Number(
        sql
          .prepare(
            `SELECT COUNT(*) AS count FROM job
              WHERE session_id = ? AND status IN ${ACTIVE_SQL}`,
          )
          .get(sessionId).count ?? 0,
      );
      if (perSession >= maxPerSession) {
        throw new JobLimitError(
          `Background job limit reached for this session: ${perSession}/${maxPerSession} jobs are active. Wait for one to finish before starting another.`,
        );
      }

      insert.run(
        id,
        sessionId,
        name,
        command,
        cwd,
        shell,
        notify,
        timeoutMs,
        status,
        Number.isInteger(fields.runnerPid ?? fields.runner_pid)
          ? fields.runnerPid ?? fields.runner_pid
          : null,
        Number.isInteger(fields.childPid ?? fields.child_pid)
          ? fields.childPid ?? fields.child_pid
          : null,
        outputPath,
        resultPath,
      );
      return parseJob(sql.prepare("SELECT * FROM job WHERE id = ?").get(id));
    });

    return run();
  }

  getJob(jobId) {
    requireText(jobId, "job_id");
    return parseJob(sql.prepare("SELECT * FROM job WHERE id = ?").get(jobId));
  }

  getJobForSession(jobId, sessionId) {
    requireText(jobId, "job_id");
    requireText(sessionId, "session_id");
    return parseJob(
      sql
        .prepare("SELECT * FROM job WHERE id = ? AND session_id = ?")
        .get(jobId, sessionId),
    );
  }

  /**
   * Active jobs first, then the newest terminal jobs. One bounded page is all
   * the process tool and HTTP list ever need.
   */
  listJobs(sessionId, { limit = 20 } = {}) {
    requireText(sessionId, "session_id");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit must be an integer between 1 and 100.");
    }
    return sql
      .prepare(
        `SELECT * FROM job
          WHERE session_id = ?
          ORDER BY CASE WHEN status IN ${ACTIVE_SQL} THEN 0 ELSE 1 END,
                   created_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(sessionId, limit)
      .map(parseJob);
  }

  listActiveJobs() {
    return sql
      .prepare(
        `SELECT * FROM job WHERE status IN ${ACTIVE_SQL} ORDER BY created_at ASC`,
      )
      .all()
      .map(parseJob);
  }

  /**
   * Oldest terminal logs first, with notification state so retention can keep
   * a tail alive while an auto-continue is still pending. Metadata is never
   * deleted here; retention only removes output.log files.
   */
  listJobLogs({ limit = 5000 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("limit must be an integer between 1 and 10000.");
    }
    return sql
      .prepare(
        `SELECT j.id, j.output_path, j.finished_at, j.created_at,
                n.state AS notification_state
           FROM job j
           LEFT JOIN job_notification n ON n.job_id = j.id
          WHERE j.status IN ${TERMINAL_SQL}
            AND j.output_path IS NOT NULL
          ORDER BY COALESCE(j.finished_at, j.created_at) ASC, j.rowid ASC
          LIMIT ?`,
      )
      .all(limit);
  }

  markRunning(jobId, { runnerPid = null, childPid = null, startedAt = null } = {}) {
    requireText(jobId, "job_id");
    sql
      .prepare(
        `UPDATE job
            SET status = 'running',
                runner_pid = COALESCE(?, runner_pid),
                child_pid = COALESCE(?, child_pid),
                started_at = COALESCE(started_at, ?),
                updated_at = datetime('now','localtime')
          WHERE id = ? AND status IN ${ACTIVE_SQL}`,
      )
      .run(
        Number.isInteger(runnerPid) ? runnerPid : null,
        Number.isInteger(childPid) ? childPid : null,
        startedAt,
        jobId,
      );
    return this.getJob(jobId);
  }

  setPids(jobId, { runnerPid = null, childPid = null } = {}) {
    requireText(jobId, "job_id");
    sql
      .prepare(
        `UPDATE job
            SET runner_pid = COALESCE(?, runner_pid),
                child_pid = COALESCE(?, child_pid),
                updated_at = datetime('now','localtime')
          WHERE id = ?`,
      )
      .run(
        Number.isInteger(runnerPid) ? runnerPid : null,
        Number.isInteger(childPid) ? childPid : null,
        jobId,
      );
    return this.getJob(jobId);
  }

  /**
   * Commit a terminal result and (optionally) create the single notification
   * row in the same transaction. Returns changed=false when another watcher or
   * the poll loop got there first, which is the normal idempotent race.
   */
  finishJob(jobId, result, { notify = false } = {}) {
    requireText(jobId, "job_id");
    const status = result?.status;
    if (!TERMINAL_JOB_STATUSES.includes(status)) {
      throw new Error(
        `result.status must be one of: ${TERMINAL_JOB_STATUSES.join(", ")}.`,
      );
    }

    const commit = sql.transaction(() => {
      const current = sql.prepare("SELECT * FROM job WHERE id = ?").get(jobId);
      if (!current) {
        return { changed: false, job: undefined, notification: undefined };
      }
      if (TERMINAL_JOB_STATUSES.includes(current.status)) {
        return {
          changed: false,
          job: parseJob(current),
          notification: parseNotification(
            sql.prepare("SELECT * FROM job_notification WHERE job_id = ?").get(jobId),
          ),
        };
      }

      sql
        .prepare(
          `UPDATE job
              SET status = ?,
                  exit_code = ?,
                  signal = ?,
                  timed_out = ?,
                  truncated = ?,
                  output_bytes = ?,
                  error = ?,
                  started_at = COALESCE(started_at, ?),
                  finished_at = COALESCE(?, datetime('now','localtime')),
                  updated_at = datetime('now','localtime')
            WHERE id = ? AND status IN ${ACTIVE_SQL}`,
        )
        .run(
          status,
          Number.isInteger(result.exitCode) ? result.exitCode : null,
          typeof result.signal === "string" ? result.signal : null,
          result.timedOut === true ? 1 : 0,
          result.truncated === true ? 1 : 0,
          Number.isInteger(result.outputBytes) ? result.outputBytes : 0,
          optionalText(result.error, "error", 4000),
          optionalText(result.startedAt, "started_at", 64),
          optionalText(result.finishedAt, "finished_at", 64),
          jobId,
        );

      let notification;
      if (notify) {
        sql
          .prepare(
            `INSERT OR IGNORE INTO job_notification (job_id, state)
             VALUES (?, 'pending')`,
          )
          .run(jobId);
        notification = sql
          .prepare("SELECT * FROM job_notification WHERE job_id = ?")
          .get(jobId);
      }

      return {
        changed: true,
        job: parseJob(sql.prepare("SELECT * FROM job WHERE id = ?").get(jobId)),
        notification: parseNotification(notification),
      };
    });

    return commit();
  }

  getNotification(jobId) {
    requireText(jobId, "job_id");
    return parseNotification(
      sql.prepare("SELECT * FROM job_notification WHERE job_id = ?").get(jobId),
    );
  }

  createNotification(jobId) {
    requireText(jobId, "job_id");
    sql
      .prepare(
        `INSERT OR IGNORE INTO job_notification (job_id, state)
         VALUES (?, 'pending')`,
      )
      .run(jobId);
    return this.getNotification(jobId);
  }

  /**
   * Atomically take ownership of a pending/failed notice. Only one dispatcher
   * can win; a scheduled or delivered notice is never repeated.
   */
  claimNotification(jobId) {
    requireText(jobId, "job_id");
    const info = sql
      .prepare(
        `UPDATE job_notification
            SET state = 'scheduled',
                attempts = attempts + 1,
                last_error = NULL,
                updated_at = datetime('now','localtime')
          WHERE job_id = ?
            AND state IN ('pending','failed')
            AND attempts < ?`,
      )
      .run(jobId, MAX_NOTIFICATION_ATTEMPTS);
    return {
      claimed: info.changes === 1,
      notification: this.getNotification(jobId),
    };
  }

  /** A busy-lock race is not a delivery attempt; give the retry slot back. */
  releaseNotification(jobId, error = null) {
    requireText(jobId, "job_id");
    sql
      .prepare(
        `UPDATE job_notification
            SET state = 'pending',
                attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
                last_error = ?,
                updated_at = datetime('now','localtime')
          WHERE job_id = ? AND state = 'scheduled'`,
      )
      .run(optionalText(error, "error", 2000), jobId);
    return this.getNotification(jobId);
  }

  markNotificationDelivered(jobId) {
    requireText(jobId, "job_id");
    sql
      .prepare(
        `UPDATE job_notification
            SET state = 'delivered',
                last_error = NULL,
                delivered_at = datetime('now','localtime'),
                updated_at = datetime('now','localtime')
          WHERE job_id = ?`,
      )
      .run(jobId);
    return this.getNotification(jobId);
  }

  markNotificationFailed(jobId, error = "notification failed") {
    requireText(jobId, "job_id");
    sql
      .prepare(
        `UPDATE job_notification
            SET state = 'failed',
                last_error = ?,
                updated_at = datetime('now','localtime')
          WHERE job_id = ?`,
      )
      .run(optionalText(error, "error", 2000), jobId);
    return this.getNotification(jobId);
  }

  listPendingNotifications({ limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("limit must be an integer between 1 and 500.");
    }
    return sql
      .prepare(
        `SELECT n.*, j.session_id, j.status AS job_status
           FROM job_notification n
           JOIN job j ON j.id = n.job_id
          WHERE n.state IN ('pending','failed')
            AND n.attempts < ?
          ORDER BY n.created_at ASC
          LIMIT ?`,
      )
      .all(MAX_NOTIFICATION_ATTEMPTS, limit)
      .map(parseNotification);
  }

  /** Auto-continue budget: job turns created in the current clock hour. */
  countJobTurnsLastHour(sessionId) {
    requireText(sessionId, "session_id");
    const row = sql
      .prepare(
        `SELECT COUNT(*) AS count FROM turn
          WHERE session_id = ?
            AND kind = 'job'
            AND created_at >= datetime('now','localtime','-1 hour')`,
      )
      .get(sessionId);
    return Number(row?.count ?? 0);
  }

  hasJobTurn(sessionId, jobId) {
    requireText(sessionId, "session_id");
    requireText(jobId, "job_id");
    return (
      sql
        .prepare(
          `SELECT 1 FROM turn
            WHERE session_id = ? AND client_message_id = ?`,
        )
        .get(sessionId, `job:${jobId}`) !== undefined
    );
  }

  counts() {
    const rows = sql
      .prepare("SELECT status, COUNT(*) AS count FROM job GROUP BY status")
      .all();
    const byStatus = Object.fromEntries(
      rows.map((row) => [row.status, Number(row.count)]),
    );
    const pending = sql
      .prepare(
        `SELECT COUNT(*) AS count FROM job_notification
          WHERE state IN ('pending','failed') AND attempts < ?`,
      )
      .get(MAX_NOTIFICATION_ATTEMPTS);
    return {
      byStatus,
      running: byStatus.running ?? 0,
      starting: byStatus.starting ?? 0,
      lost: byStatus.lost ?? 0,
      pendingNotifications: Number(pending?.count ?? 0),
    };
  }
}

export const jobStore = new JobStore();
