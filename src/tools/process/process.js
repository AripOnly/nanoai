// src/tools/process/process.js
//
// Control plane for detached shell jobs. Every operation is scoped to the
// calling session, so a model cannot poll, kill, or read another session's
// jobs even if it guesses a job id. The manager is injected through context.jobs.

import { fail } from "#src/tools/shared/index.js";

export const processTool = Object.freeze({
  type: "function",
  name: "process",
  description: `Manage detached background shell jobs started with shell({ background: true }).

Actions:
- list: current session's active jobs plus recent finished jobs.
- poll: compact status plus a bounded log tail. Poll lazily; do not sleep.
- log: read a bounded byte range or the last N lines of one job's log.
- kill: idempotently stop a job and its whole process tree.
- remove: delete a finished job's log while keeping its metadata.

Jobs are scoped to the current session. Never use this tool to inspect another session.`,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "poll", "log", "kill", "remove"],
        description: "Operation to perform.",
      },
      jobId: {
        type: "string",
        description: "Job id from shell({ background: true }); required for poll/log/kill/remove.",
      },
      sessionId: {
        type: "string",
        description:
          "Optional session id; must match the current session when provided.",
      },
      offsetBytes: {
        type: "integer",
        minimum: 0,
        description: "For log: start byte offset. Omit for the tail.",
      },
      limitBytes: {
        type: "integer",
        minimum: 1,
        maximum: 65536,
        description: "For log: maximum bytes to return (default 8192, max 65536).",
      },
      tailLines: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description: "For log: optionally keep only the last N lines of the range.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "For list: maximum jobs to return (default 20).",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
});

function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function resolveSession(params, context) {
  const current = text(context.sessionID) ?? text(context.session_id);
  const requested = text(params?.sessionId);
  if (current && requested && current !== requested) {
    throw new Error("Background jobs are scoped to the current session.");
  }
  const sessionId = current ?? requested;
  if (!sessionId) {
    throw new Error("No session is associated with this tool call.");
  }
  return sessionId;
}

function requireJobId(params) {
  const jobId = text(params?.jobId);
  if (!jobId) {
    throw new Error("Parameter 'jobId' is required for this action.");
  }
  return jobId;
}

export async function process(params, context = {}) {
  const action = text(params?.action);
  if (!action) {
    return fail("Parameter 'action' must be a non-empty string.");
  }
  if (context.policy?.allowShell === false || context.policy?.allowWrite === false) {
    return fail('Tool "process" is disabled by the agent policy.');
  }
  if (!context.jobs) {
    return fail("Background jobs are not available in this runtime.");
  }

  try {
    const sessionId = resolveSession(params, context);

    if (action === "list") {
      const limit = Number.isInteger(params?.limit) ? params.limit : 20;
      const jobs = await context.jobs.list(sessionId, { limit });
      return { success: true, jobs };
    }

    if (action === "poll") {
      const job = await context.jobs.poll(requireJobId(params), sessionId);
      return { success: true, ...job };
    }

    if (action === "log") {
      const range = await context.jobs.log(
        requireJobId(params),
        sessionId,
        {
          offsetBytes: Number.isInteger(params?.offsetBytes)
            ? params.offsetBytes
            : null,
          limitBytes: Number.isInteger(params?.limitBytes)
            ? params.limitBytes
            : 8192,
          tailLines: Number.isInteger(params?.tailLines)
            ? params.tailLines
            : null,
        },
      );
      return { success: true, ...range };
    }

    if (action === "kill") {
      const job = await context.jobs.kill(requireJobId(params), sessionId);
      return { success: true, job };
    }

    if (action === "remove") {
      const result = await context.jobs.removeLog(
        requireJobId(params),
        sessionId,
      );
      return { success: true, ...result };
    }

    return fail(`Unknown process action "${action}".`);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error?.code ? { code: error.code } : {}),
    };
  }
}
