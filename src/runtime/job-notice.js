// src/runtime/job-notice.js
//
// Auto-continue dispatcher. A finished job already has exactly one
// notification row (job_notification.job_id primary key). This module turns
// that row into at most one notice turn by:
//   1. waiting until the session is idle (retrying, never blocking a turn);
//   2. enforcing the 10-job-turns-per-session-per-hour budget;
//   3. atomically claiming the notification;
//   4. calling runTurn with kind="job" and client_message_id="job:<id>".
//
// The JOB_NOTICE event is persisted for the UI, but the runtime excludes it
// from provider history and injects it into the system instruction instead.

import { jobStore } from "#src/session/job-store.js";
import * as sessionDoor from "#src/session/index.js";
import { SessionBusyError } from "#src/session/index.js";
import { EVENT } from "#src/shared/event-type.js";
import {
  MAX_JOB_NOTICE_AGE_MS,
  MAX_NOTIFICATION_ATTEMPTS,
  isNoticeExpired,
  notificationRetryDelay,
  noticeForJob,
} from "#src/jobs/index.js";

export const MAX_JOB_TURNS_PER_HOUR = 10;

function validNotification(notification) {
  return (
    notification &&
    (notification.state === "pending" || notification.state === "failed") &&
    Number(notification.attempts ?? 0) < MAX_NOTIFICATION_ATTEMPTS
  );
}

export function createJobNotice({
  runtime,
  jobs,
  session = sessionDoor,
  logger = console,
  maxTurnsPerHour = MAX_JOB_TURNS_PER_HOUR,
  maxAgeMs = MAX_JOB_NOTICE_AGE_MS,
  busyRetryMs = 750,
  rateRetryMs = 60_000,
} = {}) {
  if (!runtime || typeof runtime.runTurn !== "function") {
    throw new TypeError("createJobNotice requires runtime.runTurn().");
  }
  if (!jobs || typeof jobs.jobConfig !== "function") {
    throw new TypeError("createJobNotice requires a job manager.");
  }

  const store = jobs.store ?? jobStore;
  const timers = new Map();
  const inFlight = new Set();
  const tasks = new Set();
  const controllers = new Map();
  let disposed = false;
  let flushing = null;

  function schedule(jobId, delayMs) {
    if (disposed || timers.has(jobId)) return;
    const timer = setTimeout(() => {
      timers.delete(jobId);
      void enqueue(jobId);
    }, Math.max(0, delayMs));
    timer.unref?.();
    timers.set(jobId, timer);
  }

  async function processNotification(jobId) {
    if (disposed) return { status: "disposed", jobId };
    if (inFlight.has(jobId)) return { status: "busy", jobId };
    inFlight.add(jobId);

    try {
      const job = store.getJob(jobId);
      if (!job) return { status: "missing", jobId };
      if (!["completed", "failed", "killed", "lost"].includes(job.status)) {
        return { status: "not-terminal", jobId };
      }

      let notification = store.getNotification(jobId);
      if (!validNotification(notification)) {
        return { status: "nothing-to-do", jobId };
      }

      const cfg = jobs.jobConfig();
      if (cfg.autoContinue !== true) {
        return { status: "disabled", jobId };
      }

      if (!session.getSession(job.session_id)) {
        store.markNotificationFailed(jobId, "The session no longer exists.");
        return { status: "missing-session", jobId };
      }

      if (
        isNoticeExpired(
          { finished_at: job.finished_at, created_at: job.created_at },
          { maxAgeMs },
        )
      ) {
        store.markNotificationFailed(
          jobId,
          "The job is older than 24 hours; poll it manually instead of auto-continuing.",
        );
        return { status: "expired", jobId };
      }

      if (store.countJobTurnsLastHour(job.session_id) >= maxTurnsPerHour) {
        schedule(jobId, rateRetryMs);
        return { status: "rate-limited", jobId };
      }

      // Wait for a human turn to release the session. Retrying is the lock
      // wait: no notification is claimed and no turn is created until idle.
      if (session.isSessionBusy(job.session_id)) {
        schedule(jobId, busyRetryMs);
        return { status: "busy", jobId };
      }

      const claim = store.claimNotification(jobId);
      if (!claim.claimed) {
        return { status: "already-scheduled", jobId };
      }
      notification = claim.notification;

      const view = typeof jobs.present === "function" ? jobs.present(job) : job;
      const notice = await noticeForJob(view);
      const controller = new AbortController();
      controllers.set(jobId, controller);

      try {
        for await (const event of runtime.runTurn({
          name: "nano",
          prompt: notice.text,
          session_id: job.session_id,
          client_message_id: `job:${job.id}`,
          turnKind: "job",
          triggerRef: job.id,
          jobNotice: notice.text,
          signal: controller.signal,
        })) {
          if (event.role === EVENT.ERROR) {
            logger.warn?.(
              `[jobs] notice turn ${jobId} reported: ${event.content?.message ?? "unknown error"}`,
            );
          }
        }
      } catch (error) {
        if (error instanceof SessionBusyError) {
          store.releaseNotification(jobId, error.message);
          schedule(jobId, busyRetryMs);
          return { status: "busy", jobId };
        }
        if (store.hasJobTurn(job.session_id, job.id)) {
          store.markNotificationDelivered(jobId);
          return { status: "delivered", jobId, recovered: true };
        }
        store.markNotificationFailed(
          jobId,
          error instanceof Error ? error.message : String(error),
        );
        if ((notification?.attempts ?? 0) < MAX_NOTIFICATION_ATTEMPTS) {
          schedule(
            jobId,
            notificationRetryDelay((notification?.attempts ?? 0) + 1),
          );
        }
        return { status: "failed", jobId };
      } finally {
        controllers.delete(jobId);
      }

      // A job turn that reached the provider is authoritative even if the
      // provider returned an error event: retrying would be a second turn.
      if (!store.hasJobTurn(job.session_id, job.id)) {
        store.markNotificationFailed(
          jobId,
          "The notice turn did not persist; it was not retried automatically.",
        );
        return { status: "failed", jobId };
      }
      store.markNotificationDelivered(jobId);
      return { status: "delivered", jobId };
    } catch (error) {
      logger.warn?.(
        `[jobs] notice ${jobId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: "error", jobId };
    } finally {
      inFlight.delete(jobId);
    }
  }

  function enqueue(jobOrId) {
    const jobId =
      typeof jobOrId === "string" ? jobOrId : jobOrId?.id ?? jobOrId?.jobId;
    if (!jobId || disposed) {
      return Promise.resolve({ status: "disposed", jobId: jobId ?? null });
    }
    const task = processNotification(jobId);
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
    return task;
  }

  async function flush() {
    if (disposed) return { processed: 0 };
    if (flushing) return flushing;
    flushing = (async () => {
      const pending = store.listPendingNotifications({ limit: 100 });
      let processed = 0;
      for (const notification of pending) {
        if (disposed) break;
        const result = await enqueue(notification.job_id);
        if (result.status !== "nothing-to-do") processed += 1;
      }
      return { processed };
    })();
    try {
      return await flushing;
    } finally {
      flushing = null;
    }
  }

  function start() {
    return flush();
  }

  async function dispose() {
    disposed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const controller of controllers.values()) {
      try {
        controller.abort(new Error("Gateway shutting down"));
      } catch {
        // Continue aborting the rest.
      }
    }
    await Promise.allSettled([...tasks]);
  }

  return Object.freeze({
    enqueue,
    flush,
    start,
    dispose,
    get pending() {
      return store.listPendingNotifications({ limit: 100 }).length;
    },
  });
}
