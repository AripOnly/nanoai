// gateway/middleware/error-middleware.js

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

  res.status(status).json({
    role: EVENT.ERROR,
    content: {
      message: err.message,
    },
  });
}

export { errorMiddleware };
