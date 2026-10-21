// gateway/service/job-service.js
//
// HTTP use-cases for durable background jobs. The manager is owned by the
// composition root and reached through app.locals; this service only validates
// request shape and translates job errors into the shared HTTP envelope.

import { ResponseError } from "../error/response-error.js";

function managerOrThrow(jobs) {
  if (!jobs || typeof jobs.list !== "function") {
    throw new ResponseError(503, "Background jobs are not available.");
  }
  return jobs;
}

function requireSessionId(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ResponseError(400, "session_id must be a non-empty string.");
  }
  return value.trim();
}

function requireJobId(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ResponseError(400, "job_id must be a non-empty string.");
  }
  return value.trim();
}

function translate(error) {
  if (error instanceof ResponseError) return error;
  if (error?.code === "JOB_NOT_FOUND") {
    return new ResponseError(404, error.message);
  }
  if (error?.code === "JOB_ACTIVE") {
    return new ResponseError(409, error.message);
  }
  return error;
}

export function createJobService(jobs) {
  const manager = managerOrThrow(jobs);

  return Object.freeze({
    async list(query = {}) {
      const sessionId = requireSessionId(query.session_id);
      const limit = Number(query.limit ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ResponseError(400, "limit must be between 1 and 100.");
      }
      try {
        return await manager.list(sessionId, { limit });
      } catch (error) {
        throw translate(error);
      }
    },

    async get(jobId, query = {}) {
      const id = requireJobId(jobId);
      const sessionId = requireSessionId(query.session_id);
      try {
        return await manager.poll(id, sessionId);
      } catch (error) {
        throw translate(error);
      }
    },

    async kill(jobId, body = {}, query = {}) {
      const id = requireJobId(jobId);
      const sessionId = requireSessionId(body.session_id ?? query.session_id);
      try {
        return await manager.kill(id, sessionId);
      } catch (error) {
        throw translate(error);
      }
    },

    async removeLog(jobId, query = {}) {
      const id = requireJobId(jobId);
      const sessionId = requireSessionId(query.session_id);
      try {
        return await manager.removeLog(id, sessionId);
      } catch (error) {
        throw translate(error);
      }
    },
  });
}
