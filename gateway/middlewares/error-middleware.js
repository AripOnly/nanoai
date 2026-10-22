// gateway/middlewares/error-middleware.js
//
// One error envelope for every backend failure. Client-facing messages are
// sanitized: 4xx text (validation, not found) is written for the caller and
// passes through; 5xx text describes internals, so it is logged server-side
// and replaced with a generic line.

import { ResponseError } from "../error/response-error.js";
import { EVENT } from "../../src/shared/event-type.js";

async function errorMiddleware(err, req, res, next) {
  if (!err) {
    return next();
  }

  // All backend errors share the event envelope so every client
  // (web, CLI, and future channels) handles them the same way.
  // Honor upstream HTTP statuses (e.g. the JSON body parser's 400)
  // instead of flattening everything to 500.
  const upstream =
    Number.isInteger(err.status) && err.status >= 400 && err.status < 600
      ? err.status
      : null;
  const status =
    err instanceof ResponseError ? (err.status ?? 400) : (upstream ?? 500);

  const callerFacing =
    err instanceof ResponseError || (upstream !== null && upstream < 500);
  if (status >= 500) {
    const logger = req.app?.locals?.logger;
    if (logger?.error) {
      logger.error("request failed", {
        event: "http.request.failed",
        method: req.method,
        path: req.path,
        status,
        error: err,
      });
    } else {
      console.error("[nanoai] request failed:", err);
    }
  }

  res.status(status).json({
    role: EVENT.ERROR,
    content: {
      message: callerFacing
        ? err.message || "Request failed"
        : "Internal server error",
    },
  });
}

export { errorMiddleware };
