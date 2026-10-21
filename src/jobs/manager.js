// src/jobs/manager.js
//
// Gateway-owned job manager. It persists metadata through src/session/job-store,
// starts detached runners, watches result.json (with a poll fallback), and
// reconciles surviving jobs after a restart. It never kills jobs on dispose:
// only an explicit kill or the runner's own timeout does that.
//
// The manager is dependency-injected into the runtime's tool context, so tools
// never reach a process-wide singleton.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { dataDir } from "#src/shared/data-dir.js";
import { JOBS_DEFAULTS } from "#src/config/schema.js";
import {
  JobLimitError,
  jobStore,
  newJobId,
} from "#src/session/job-store.js";
import { isProcessAlive, killProcessTree } from "./kill-tree.js";
import {
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  JOB_NOTIFY_VALUES,
  MAX_BACKGROUND_TIMEOUT_MS,
  isTerminalStatus,
  jobName,
  normalizeBackgroundTimeout,
  normalizeNotify,
  shouldNotify,
} from "./policy.js";
import {
  MAX_LOG_READ_BYTES,
  readLogRange,
  readTail,
} from "./notify.js";
import { inspectJob, readPidFile, readResultFile } from "./reconcile.js";
import {
  RUNNER_PATH,
  clearKillRequest,
  ensureJobDir,
  jobPaths,
  requestKill,
  spawnRunner,
  waitForPidFile,
  writeJobSpec,
  writeResultFile,
} from "./spawn.js";

const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{8,128}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOTAL_LOG_BYTES = 100 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 3650;
const PROTECTED_NOTIFICATION_STATES = new Set([
  "pending",
  "scheduled",
  "failed",
]);

function dateMs(value, fallback = null) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function notFound(jobId) {
  const error = new Error(`Background job "${jobId}" was not found.`);
  error.code = "JOB_NOT_FOUND";
  return error;
}

function snapshotJobs(config) {
  let snapshot;
  try {
    snapshot = typeof config === "function" ? config() : config;
  } catch {
    snapshot = {};
  }
  const raw =
    snapshot?.value?.jobs ??
    snapshot?.jobs ??
    {};
  return { ...JOBS_DEFAULTS, ...raw };
}

function boundedInteger(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

export class JobManager {
  constructor({
    config = () => ({}),
    logger = console,
    rootDir = null,
    runnerPath = RUNNER_PATH,
    store = jobStore,
  } = {}) {
    this.config = config;
    this.logger = logger;
    this.rootDir = rootDir ?? path.join(dataDir(), "jobs");
    this.runnerPath = runnerPath;
    this.store = store;
    this.watchers = new Map();
    this.refreshing = new Set();
    this.completionHandler = null;
    this.lastReconcileAt = null;
    this.lastPruneAt = null;
    this.pruning = null;
    this.disposed = false;
  }

  jobConfig() {
    const cfg = snapshotJobs(this.config);
    const maxTimeoutMs = boundedInteger(
      cfg.maxTimeoutMs,
      MAX_BACKGROUND_TIMEOUT_MS,
      1_000,
      MAX_BACKGROUND_TIMEOUT_MS,
    );
    return {
      ...cfg,
      enabled: cfg.enabled !== false,
      maxRunning: boundedInteger(cfg.maxRunning, 4, 1, 64),
      maxPerSession: boundedInteger(cfg.maxPerSession, 2, 1, 64),
      pollIntervalMs: boundedInteger(cfg.pollIntervalMs, 2000, 250, 60_000),
      maxLogBytes: boundedInteger(
        cfg.maxLogBytes,
        50 * 1024 * 1024,
        1024,
        1024 * 1024 * 1024,
      ),
      defaultTimeoutMs: boundedInteger(
        cfg.defaultTimeoutMs,
        DEFAULT_BACKGROUND_TIMEOUT_MS,
        1_000,
        maxTimeoutMs,
      ),
      maxTimeoutMs,
      maxTotalLogBytes: boundedInteger(
        cfg.maxTotalLogBytes,
        DEFAULT_MAX_TOTAL_LOG_BYTES,
        1024,
        10 * 1024 * 1024 * 1024,
      ),
      retentionDays: boundedInteger(
        cfg.retentionDays,
        DEFAULT_RETENTION_DAYS,
        0,
        MAX_RETENTION_DAYS,
      ),
      notifyDefault: JOB_NOTIFY_VALUES.includes(cfg.notifyDefault)
        ? cfg.notifyDefault
        : "always",
    };
  }

  directory(jobId) {
    if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
      throw new Error("Invalid job id.");
    }
    return path.join(this.rootDir, jobId);
  }

  setCompletionHandler(handler) {
    this.completionHandler = typeof handler === "function" ? handler : null;
  }

  /**
   * Validate limits, write spec.json, insert metadata, and start the detached
   * runner. Policy gating belongs to the tool; the manager re-checks values.
   */
  async create({
    sessionId,
    command,
    cwd,
    shell,
    name,
    notify,
    timeoutMs,
  } = {}) {
    if (this.disposed) {
      throw new Error("The background job manager has been disposed.");
    }
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      throw new Error("sessionId is required for a background job.");
    }
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error("command must be a non-empty string.");
    }
    if (typeof cwd !== "string" || cwd.trim() === "") {
      throw new Error("cwd must be a non-empty string.");
    }
    if (typeof shell !== "string" || shell.trim() === "") {
      throw new Error("shell must be a non-empty string.");
    }

    const cfg = this.jobConfig();
    if (!cfg.enabled) {
      const error = new Error(
        "Background jobs are disabled in settings (jobs.enabled=false).",
      );
      error.code = "JOB_DISABLED";
      throw error;
    }
    const timeout = normalizeBackgroundTimeout(timeoutMs, {
      defaultMs: cfg.defaultTimeoutMs,
      maxMs: cfg.maxTimeoutMs,
    });
    const notifyPolicy = normalizeNotify(notify, cfg.notifyDefault);
    const jobId = newJobId();
    const directory = this.directory(jobId);
    const paths = await ensureJobDir(directory);
    const createdAt = new Date().toISOString();
    const spec = {
      version: 1,
      jobId,
      command,
      cwd,
      shell,
      notify: notifyPolicy,
      timeoutMs: timeout,
      maxLogBytes: cfg.maxLogBytes,
      createdAt,
      outputPath: paths.output,
      resultPath: paths.result,
    };

    try {
      await writeJobSpec(paths.spec, spec);
    } catch (error) {
      await fsp.rm(directory, { recursive: true, force: true });
      throw error;
    }

    let job;
    try {
      job = this.store.createJob(
        {
          id: jobId,
          sessionId,
          name: jobName(name, command),
          command,
          cwd,
          shell,
          notify: notifyPolicy,
          timeoutMs: timeout,
          outputPath: paths.output,
          resultPath: paths.result,
        },
        {
          maxRunning: cfg.maxRunning,
          maxPerSession: cfg.maxPerSession,
        },
      );
    } catch (error) {
      await fsp.rm(directory, { recursive: true, force: true });
      if (error instanceof JobLimitError) throw error;
      if (String(error?.code ?? "").includes("SQLITE_CONSTRAINT")) {
        const friendly = new Error("The session for this job no longer exists.");
        friendly.code = "JOB_SESSION_MISSING";
        throw friendly;
      }
      throw error;
    }

    let spawnedPid;
    try {
      spawnedPid = spawnRunner({
        jobId,
        specPath: paths.spec,
        runnerPath: this.runnerPath,
      });
    } catch (error) {
      const result = {
        status: "failed",
        exitCode: null,
        signal: null,
        timedOut: false,
        startedAt: null,
        finishedAt: new Date().toISOString(),
        outputBytes: 0,
        truncated: false,
        error: `Could not start the job runner: ${error.message}`,
      };
      try {
        await writeResultFile(paths.result, { jobId, ...result });
      } catch {
        // The database row is still marked below.
      }
      await this.finalize(job, result);
      throw error;
    }

    const runnerPid =
      (await waitForPidFile(paths.runnerPid, 1200)) ?? spawnedPid;
    const childPid = await readPidFile(paths.childPid);
    job = this.store.markRunning(jobId, {
      runnerPid,
      childPid,
      startedAt: createdAt,
    });
    this.attach(job);
    await this.refresh(jobId);
    return this.present(this.store.getJob(jobId) ?? job);
  }

  requireJob(jobId, sessionId) {
    const job = this.store.getJobForSession(jobId, sessionId);
    if (!job) throw notFound(jobId);
    return job;
  }

  /** Active first, newest terminal last; bounded by limit. */
  async list(sessionId, { limit = 20 } = {}) {
    const jobs = this.store.listJobs(sessionId, { limit });
    await Promise.all(
      jobs
        .filter((job) => !isTerminalStatus(job.status))
        .map((job) => this.refresh(job.id)),
    );
    return this.store
      .listJobs(sessionId, { limit })
      .map((job) => this.present(job));
  }

  async poll(jobId, sessionId) {
    let job = this.requireJob(jobId, sessionId);
    if (!isTerminalStatus(job.status)) {
      await this.refresh(jobId);
      job = this.store.getJob(jobId) ?? job;
    }
    const tail = await readTail(job.output_path, {
      maxBytes: 8192,
      maxLines: 60,
    });
    return {
      ...this.present(job),
      tail: tail.text,
      tailTruncated: tail.truncated,
    };
  }

  async log(
    jobId,
    sessionId,
    { offsetBytes = null, limitBytes = 8192, tailLines = null } = {},
  ) {
    const job = this.requireJob(jobId, sessionId);
    const range = await readLogRange(job.output_path, {
      offsetBytes,
      limitBytes: boundedInteger(limitBytes, 8192, 1, MAX_LOG_READ_BYTES),
      tailLines: Number.isInteger(tailLines) ? tailLines : null,
    });
    return {
      jobId: job.id,
      status: job.status,
      ...range,
    };
  }

  attach(job) {
    if (this.disposed || !job || isTerminalStatus(job.status)) return;
    const jobId = job.id;
    if (this.watchers.has(jobId)) return;

    const cfg = this.jobConfig();
    const paths = jobPaths(this.directory(jobId));
    let watcher = null;
    try {
      watcher = fs.watch(paths.dir, { persistent: false }, (_event, filename) => {
        if (filename && filename !== "result.json") return;
        void this.refresh(jobId);
      });
      watcher.on("error", () => {});
    } catch {
      watcher = null;
    }

    const poll = setInterval(() => {
      void this.refresh(jobId);
    }, cfg.pollIntervalMs);
    poll.unref?.();

    this.watchers.set(jobId, { watcher, poll });
  }

  stopWatching(jobId) {
    const entry = this.watchers.get(jobId);
    if (!entry) return;
    this.watchers.delete(jobId);
    try {
      entry.watcher?.close();
    } catch {
      // Already closed.
    }
    clearInterval(entry.poll);
  }

  async refresh(jobId) {
    if (this.disposed || this.refreshing.has(jobId)) return;
    this.refreshing.add(jobId);
    try {
      const job = this.store.getJob(jobId);
      if (!job) {
        this.stopWatching(jobId);
        return;
      }
      if (isTerminalStatus(job.status)) {
        this.stopWatching(jobId);
        return;
      }

      const result = await readResultFile(job.result_path);
      if (result) {
        await this.finalize(job, result);
        return;
      }

      const runnerPid =
        (await readPidFile(jobPaths(this.directory(jobId)).runnerPid)) ??
        job.runner_pid;
      if (runnerPid && !isProcessAlive(runnerPid)) {
        // The runner may have written the result between our first read and
        // the liveness probe; re-read once before declaring it lost.
        const late = await readResultFile(job.result_path);
        if (late) {
          await this.finalize(job, late);
        } else {
          await this.finalizeLost(
            job,
            "The job runner exited before writing result.json.",
          );
        }
      }
    } catch (error) {
      this.logger?.warn?.(`[jobs] refresh ${jobId} failed: ${error.message}`);
    } finally {
      this.refreshing.delete(jobId);
    }
  }

  async finalize(job, result) {
    const notify = shouldNotify(job.notify, result.status);
    const outcome = this.store.finishJob(job.id, result, { notify });
    if (!outcome.changed) {
      this.stopWatching(job.id);
      return outcome.job;
    }
    this.stopWatching(job.id);
    this.logger?.info?.(
      `[jobs] ${job.id} finished with status ${result.status}`,
    );
    if (outcome.notification && this.completionHandler) {
      try {
        Promise.resolve(this.completionHandler(outcome.job)).catch((error) => {
          this.logger?.warn?.(
            `[jobs] notification handler failed: ${error.message}`,
          );
        });
      } catch (error) {
        this.logger?.warn?.(
          `[jobs] notification handler failed: ${error.message}`,
        );
      }
    }
    // Housekeeping is best effort and never blocks a result becoming durable.
    void this.pruneLogs().catch((error) => {
      this.logger?.warn?.(`[jobs] log retention failed: ${error.message}`);
    });
    return outcome.job;
  }

  async finalizeLost(job, reason) {
    let outputBytes = 0;
    try {
      outputBytes = (await fsp.stat(job.output_path)).size;
    } catch {
      // No log.
    }
    return this.finalize(job, {
      status: "lost",
      exitCode: null,
      signal: null,
      timedOut: false,
      startedAt: job.started_at,
      finishedAt: new Date().toISOString(),
      outputBytes,
      truncated: false,
      error: reason,
    });
  }

  /** Idempotent explicit kill: kill request first, force tree-kill fallback. */
  async kill(jobId, sessionId, { reason = "Killed by user request." } = {}) {
    let job = this.requireJob(jobId, sessionId);
    if (isTerminalStatus(job.status)) return this.present(job);

    const directory = this.directory(jobId);
    const paths = jobPaths(directory);
    await requestKill(directory);

    const runnerPid =
      (await readPidFile(paths.runnerPid)) ?? job.runner_pid ?? null;
    if (runnerPid && isProcessAlive(runnerPid)) {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const result = await readResultFile(job.result_path);
        if (result) {
          await this.finalize(job, result);
          return this.present(this.store.getJob(jobId) ?? job);
        }
        const current = this.store.getJob(jobId);
        if (current && isTerminalStatus(current.status)) {
          return this.present(current);
        }
        await delay(100);
      }
    }

    const childPid =
      (await readPidFile(paths.childPid)) ?? job.child_pid ?? null;
    if (childPid && isProcessAlive(childPid)) {
      await killProcessTree(childPid);
    }
    if (runnerPid && isProcessAlive(runnerPid)) {
      await killProcessTree(runnerPid);
    }
    await clearKillRequest(directory);

    let outputBytes = 0;
    try {
      outputBytes = (await fsp.stat(job.output_path)).size;
    } catch {
      // No log.
    }
    const result = {
      status: "killed",
      exitCode: null,
      signal: null,
      timedOut: false,
      startedAt: job.started_at,
      finishedAt: new Date().toISOString(),
      outputBytes,
      truncated: false,
      error: reason,
    };
    try {
      await writeResultFile(job.result_path, result);
    } catch {
      // The database row is still terminal.
    }
    await this.finalize(job, result);
    return this.present(this.store.getJob(jobId) ?? job);
  }

  async killBySession(sessionId, options = {}) {
    const jobs = this.store
      .listJobs(sessionId, { limit: 100 })
      .filter((job) => !isTerminalStatus(job.status));
    const settled = await Promise.allSettled(
      jobs.map((job) => this.kill(job.id, sessionId, options)),
    );
    return settled.map((entry, index) => ({
      jobId: jobs[index].id,
      ok: entry.status === "fulfilled",
      error:
        entry.status === "rejected"
          ? (entry.reason?.message ?? String(entry.reason))
          : null,
    }));
  }

  /** Delete the log but keep the metadata and terminal status. */
  async removeLog(jobId, sessionId) {
    const job = this.requireJob(jobId, sessionId);
    if (!isTerminalStatus(job.status)) {
      const error = new Error("Only a finished job's log can be removed.");
      error.code = "JOB_ACTIVE";
      throw error;
    }
    await fsp.rm(job.output_path, { force: true });
    return { jobId: job.id, removed: true, status: job.status };
  }

  /**
   * Enforce the log retention policy: delete terminal logs older than
   * jobs.retentionDays, then the oldest remaining logs until total bytes are
   * under jobs.maxTotalLogBytes. A log still needed by a pending auto-continue
   * is protected from the size cap. Metadata and result.json are never touched.
   */
  async pruneLogs({ now = Date.now() } = {}) {
    if (this.pruning) return this.pruning;
    this.pruning = this.pruneLogsNow({ now }).finally(() => {
      this.pruning = null;
    });
    return this.pruning;
  }

  async pruneLogsNow({ now }) {
    const cfg = this.jobConfig();
    const rows = this.store.listJobLogs({ limit: 5000 });
    const entries = [];
    let totalBytes = 0;

    for (const row of rows) {
      let stat;
      try {
        stat = await fsp.stat(row.output_path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      entries.push({
        row,
        size: stat.size,
        stamp: dateMs(
          row.finished_at,
          dateMs(row.created_at, stat.mtimeMs),
        ),
        protectedByNotice: PROTECTED_NOTIFICATION_STATES.has(
          row.notification_state,
        ),
      });
      totalBytes += stat.size;
    }

    const cutoff =
      cfg.retentionDays > 0 ? now - cfg.retentionDays * DAY_MS : null;
    let removed = 0;
    let freedBytes = 0;

    for (const entry of entries) {
      const expired = cutoff !== null && entry.stamp < cutoff;
      const over = totalBytes > cfg.maxTotalLogBytes;
      if (!expired && !over) break;
      if (!expired && over && entry.protectedByNotice) continue;
      try {
        await fsp.rm(entry.row.output_path, { force: true });
      } catch {
        continue;
      }
      totalBytes -= entry.size;
      freedBytes += entry.size;
      removed += 1;
    }

    this.lastPruneAt = new Date().toISOString();
    if (removed > 0) {
      this.logger?.info?.(
        `[jobs] retained ${totalBytes} log bytes; removed ${removed} old logs.`,
      );
    }
    return { removed, freedBytes, remainingBytes: totalBytes };
  }

  /**
   * Boot recovery: result file wins; a live verified runner is adopted; every
   * other active row becomes lost. No job is started or restarted here.
   */
  async init() {
    if (this.disposed) {
      return { inspected: 0, running: 0, finished: 0, lost: 0, logsRemoved: 0 };
    }
    const summary = {
      inspected: 0,
      running: 0,
      finished: 0,
      lost: 0,
      logsRemoved: 0,
    };
    const active = this.store.listActiveJobs();
    for (const job of active) {
      summary.inspected += 1;
      const outcome = await inspectJob(job, {
        jobDir: this.directory(job.id),
      });
      if (outcome.state === "result") {
        await this.finalize(job, outcome.result);
        summary.finished += 1;
      } else if (outcome.state === "running") {
        const updated = this.store.markRunning(job.id, {
          runnerPid: outcome.runnerPid,
          childPid: outcome.childPid,
          startedAt: job.started_at,
        });
        this.store.setPids(job.id, {
          runnerPid: outcome.runnerPid,
          childPid: outcome.childPid,
        });
        this.attach(updated ?? job);
        summary.running += 1;
      } else {
        await this.finalizeLost(job, outcome.reason);
        summary.lost += 1;
      }
    }
    const pruned = await this.pruneLogs();
    summary.logsRemoved = pruned.removed;
    this.lastReconcileAt = new Date().toISOString();
    return summary;
  }

  stats() {
    const cfg = this.jobConfig();
    return {
      ...this.store.counts(),
      enabled: cfg.enabled,
      maxRunning: cfg.maxRunning,
      maxPerSession: cfg.maxPerSession,
      defaultTimeoutMs: cfg.defaultTimeoutMs,
      maxTimeoutMs: cfg.maxTimeoutMs,
      maxLogBytes: cfg.maxLogBytes,
      maxTotalLogBytes: cfg.maxTotalLogBytes,
      retentionDays: cfg.retentionDays,
      autoContinue: cfg.autoContinue,
      notifyDefault: cfg.notifyDefault,
      pollIntervalMs: cfg.pollIntervalMs,
      lastReconcileAt: this.lastReconcileAt,
      lastPruneAt: this.lastPruneAt,
    };
  }

  present(job) {
    if (!job) return null;
    const cfg = this.jobConfig();
    return {
      jobId: job.id,
      sessionId: job.session_id,
      name: job.name,
      command: job.command,
      cwd: job.cwd,
      shell: job.shell,
      notify: job.notify,
      timeoutMs: job.timeout_ms,
      status: job.status,
      runnerPid: job.runner_pid,
      childPid: job.child_pid,
      exitCode: job.exit_code,
      signal: job.signal,
      timedOut: job.timed_out,
      truncated: job.truncated,
      outputBytes: job.output_bytes,
      error: job.error,
      logPath: job.output_path,
      resultPath: job.result_path,
      createdAt: job.created_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      pollAfterMs: cfg.pollIntervalMs,
    };
  }

  /** Stop watchers/timers only. Active jobs intentionally keep running. */
  dispose() {
    this.disposed = true;
    for (const jobId of [...this.watchers.keys()]) {
      this.stopWatching(jobId);
    }
    this.completionHandler = null;
  }
}

export function createJobManager(options) {
  return new JobManager(options);
}
