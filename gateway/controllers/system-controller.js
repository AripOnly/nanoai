// gateway/controllers/system-controller.js
//
// Authenticated process control. The only action today is a deliberate
// graceful shutdown: the caller must send `{ "confirm": "shutdown" }`, the
// response goes out first, and the composition root performs the same shutdown
// path as SIGINT/SIGTERM. A daemon can therefore stop the gateway gracefully
// on Windows, where signal delivery cannot be relied on.

import { ResponseError } from "../error/response-error.js";

function afterResponse(res, callback) {
  if (typeof res.once === "function") {
    res.once("finish", () => setImmediate(callback));
    return;
  }
  setImmediate(callback);
}

async function shutdown(req, res, next) {
  try {
    const confirmation = req.body?.confirm ?? req.get?.("x-nanoai-confirm");
    if (confirmation !== "shutdown") {
      throw new ResponseError(
        400,
        'Shutdown requires confirmation: send {"confirm":"shutdown"}.',
      );
    }

    const app = req.app;
    if (app?.locals?.shuttingDown) {
      throw new ResponseError(409, "Gateway shutdown is already in progress.");
    }

    const stop = app?.locals?.shutdown;
    if (typeof stop !== "function") {
      throw new ResponseError(503, "Graceful shutdown is not available in this runtime.");
    }

    if (app?.locals) app.locals.shuttingDown = true;

    res.status(202).send({
      status: "accepted",
      action: "shutdown",
    });

    // Let the response and audit entry finish before aborting turns and
    // closing sockets. A failed send still triggers the shutdown.
    afterResponse(res, () => {
      Promise.resolve()
        .then(() => stop("HTTP request"))
        .catch((error) => {
          try {
            app?.locals?.logger?.error?.("HTTP shutdown failed", {
              event: "gateway.shutdown.error",
              error,
            });
          } catch {
            // Logging must not block process exit.
          }
        });
    });
  } catch (error) {
    next(error);
  }
}

export const systemController = Object.freeze({ shutdown });
