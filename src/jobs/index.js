// src/jobs/index.js
//
// Public door for durable background jobs. Gateway composition creates one
// JobManager; the runtime receives it and hands it to tools through their
// execution context. The detached runner is an entry point, not an import.

export { JobManager, createJobManager } from "./manager.js";
export {
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  JOB_NOTIFY_VALUES,
  MAX_BACKGROUND_TIMEOUT_MS,
  MAX_JOB_NOTICE_AGE_MS,
  MAX_JOB_NOTICE_BYTES,
  JobPolicyError,
  assertBackgroundAllowed,
  formatJobNotice,
  isNoticeExpired,
  isTerminalStatus,
  jobName,
  normalizeBackgroundTimeout,
  normalizeNotify,
  shouldNotify,
} from "./policy.js";
export {
  DEFAULT_LOG_TAIL_BYTES,
  MAX_NOTIFICATION_ATTEMPTS,
  noticeForJob,
  readLogRange,
  readTail,
  readTail as readJobTail,
  notificationRetryDelay,
} from "./notify.js";
export {
  inspectJob,
  processCommandLine,
  readResultFile,
  verifyRunnerProcess,
} from "./reconcile.js";
export { RUNNER_MARKER, RUNNER_PATH, jobPaths } from "./spawn.js";
