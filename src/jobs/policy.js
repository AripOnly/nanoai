// src/jobs/policy.js
//
// Background-job business rules with no I/O: timeout bounds, notify policy,
// policy gating, and the bounded notice text handed to the model. Keeping this
// pure makes it safe to unit test and impossible for the detached runner to
// pull settings or sessions in through a helper.

export const DEFAULT_BACKGROUND_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_BACKGROUND_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MAX_JOB_NOTICE_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_JOB_NOTICE_BYTES = 8192;
export const MAX_JOB_NOTICE_LINES = 60;
export const JOB_NOTIFY_VALUES = Object.freeze(["always", "failure", "never"]);
export const TERMINAL_STATUSES = Object.freeze([
  "completed",
  "failed",
  "killed",
  "lost",
]);

export class JobPolicyError extends Error {
  constructor(message, code = "JOB_POLICY") {
    super(message);
    this.name = "JobPolicyError";
    this.code = code;
  }
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

/** Background is a per-agent capability, not a global default. */
export function assertBackgroundAllowed(policy = {}) {
  if (policy?.shell?.background !== true) {
    throw new JobPolicyError(
      'Background jobs are not allowed by this agent policy. Use a foreground shell call instead.',
    );
  }
}

export function normalizeNotify(value, fallback = "always") {
  if (value === undefined || value === null || value === "") return fallback;
  if (!JOB_NOTIFY_VALUES.includes(value)) {
    throw new JobPolicyError(
      `notify must be one of: ${JOB_NOTIFY_VALUES.join(", ")}.`,
    );
  }
  return value;
}

export function normalizeBackgroundTimeout(
  value,
  {
    defaultMs = DEFAULT_BACKGROUND_TIMEOUT_MS,
    maxMs = MAX_BACKGROUND_TIMEOUT_MS,
  } = {},
) {
  if (value === undefined || value === null) return defaultMs;
  if (!Number.isInteger(value) || value <= 0) {
    throw new JobPolicyError(
      "timeout must be a positive integer number of milliseconds for a background job.",
    );
  }
  if (value > maxMs) {
    const hours = Math.max(1, Math.round(maxMs / (60 * 60 * 1000)));
    throw new JobPolicyError(
      `Background job timeout must be at most ${maxMs} ms (${hours} hours).`,
    );
  }
  return value;
}

export function jobName(name, command, max = 120) {
  const source =
    typeof name === "string" && name.trim() !== ""
      ? name.trim()
      : String(command).split(/\r?\n/, 1)[0].trim();
  return source.length > max ? `${source.slice(0, max - 1)}…` : source;
}

/** Completion policy: always, failures only, or polling only. */
export function shouldNotify(notify, status) {
  if (!isTerminalStatus(status)) return false;
  if (notify === "always") return true;
  if (notify === "failure") return status !== "completed";
  return false;
}

export function isNoticeExpired(job, { now = Date.now(), maxAgeMs = MAX_JOB_NOTICE_AGE_MS } = {}) {
  const stamp = job?.finishedAt ?? job?.finished_at ?? job?.createdAt ?? job?.created_at;
  if (!stamp) return false;
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return false;
  return now - parsed > maxAgeMs;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clipped(value, max) {
  const text = String(value ?? "").replace(/\r\n/g, "\n");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * One bounded, self-describing notice. The full log never enters the prompt;
 * the model is told to use process.poll/process.log for more.
 */
export function formatJobNotice(job, { tail = "" } = {}) {
  const id = job.jobId ?? job.id ?? "unknown";
  const status = job.status ?? "unknown";
  const exitCode =
    job.exitCode === null || job.exitCode === undefined ? "null" : job.exitCode;
  const lines = [
    `<background-job id="${xmlEscape(id)}" status="${xmlEscape(status)}" exitCode="${xmlEscape(exitCode)}" timedOut="${job.timedOut === true}">`,
  ];
  if (job.name) lines.push(`Name: ${clipped(job.name, 200)}`);
  lines.push(`Command: ${clipped(job.command ?? "", 500)}`);
  if (job.cwd) lines.push(`Cwd: ${clipped(job.cwd, 500)}`);
  if (job.error) lines.push(`Error: ${clipped(job.error, 500)}`);
  if (tail.trim() !== "") {
    lines.push("Tail:", clipped(tail, MAX_JOB_NOTICE_BYTES));
  }
  lines.push(
    "Use process.poll for details and process.log for a bounded log range.",
  );
  lines.push("</background-job>");
  return lines.join("\n");
}
