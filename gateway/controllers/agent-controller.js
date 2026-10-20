// gateway/controllers/agent-controller.js
//
// Thin HTTP door: parse, delegate, stream. Business validation belongs to
// agent-service; this file only knows about HTTP and the SSE envelope.

import { agentService } from "../service/agent-service.js";
import { ResponseError } from "../error/response-error.js";
import { EVENT } from "../../src/shared/event-type.js";

async function agentController(req, res, next) {
  try {
    // Validation happens inside the service; it throws before streaming, so
    // the error middleware can still answer with a plain HTTP status.
    const stream = agentService(req.body ?? {});

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    for await (const event of stream) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: EVENT.DONE })}\n\n`);
    res.end();
  } catch (error) {
    // Validation failed before streaming started: let the error
    // middleware respond with the proper HTTP status code.
    if (!res.headersSent) {
      return next(error);
    }

    // Mid-stream failure: the status line is already sent, so report through
    // the event envelope instead. Expected messages pass through; internal
    // ones are sanitized (the full error goes to the server log).
    console.error("Error in agent controller:", error);
    const message =
      error instanceof ResponseError
        ? error.message
        : "Internal server error while streaming the response.";
    try {
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ role: EVENT.ERROR, content: { message } })}\n\n`,
        );
      }
    } catch {
      // Client already gone, ignore write errors.
    }
    try {
      if (!res.writableEnded) {
        res.end();
      }
    } catch {
      // Client already gone, ignore end errors.
    }
  }
}

export { agentController };
