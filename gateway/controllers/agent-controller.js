// gateway/controllers/agent-controller.js
//
// Thin HTTP door: parse, delegate, stream. Business validation belongs to
// agent-service; this file only knows about HTTP and the SSE envelope.
//
// Two rules keep errors honest:
// - SSE headers are not written until the first event actually exists, so a
//   validation/busy error can still become a plain 409/400.
// - A client disconnect aborts the turn; the stream is iterated manually so
//   the generator's finally/commit still runs.
//
// createAgentController() accepts a service for contract tests; production
// uses the module-level agentService.

import { agentService } from "../service/agent-service.js";
import { ResponseError } from "../error/response-error.js";
import { EVENT } from "../../src/shared/event-type.js";
import { trackActiveTurn } from "../lifecycle/active-turns.js";

function writeEvent(res, event) {
  if (res.writableEnded || res.destroyed) return false;
  const ok = res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (ok) return true;
  if (res.writableEnded || res.destroyed) return false;
  return waitForDrain(res);
}

function waitForDrain(res) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
  });
}

function sseError(error) {
  const message =
    error instanceof ResponseError
      ? error.message
      : "Internal server error while streaming the response.";
  return { role: EVENT.ERROR, content: { message } };
}

function hasSentHeaders(res) {
  return res.headersSent === true;
}

export function createAgentController(service = agentService) {
  if (typeof service !== "function") {
    throw new TypeError("createAgentController requires a service function.");
  }

  return async function agentController(req, res, next) {
    const abort = new AbortController();
    const untrack = trackActiveTurn(abort);
    let finished = false;
    let iterator;
    let done = false;

    const onClose = () => {
      if (finished || res.writableEnded) return;
      abort.abort(new Error("Client disconnected"));
    };
    const onRequestClose = () => {
      if (req.aborted) onClose();
    };

    req.on("aborted", onClose);
    req.on("close", onRequestClose);
    res.on("close", onClose);

    try {
      const stream = service(req.body ?? {}, { signal: abort.signal });
      iterator = stream[Symbol.asyncIterator]();

      // Wait for the first event before committing to a 200 SSE response.
      let step = await iterator.next();
      if (abort.signal.aborted) return;

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      while (!step.done) {
        if (abort.signal.aborted) break;
        const ok = await writeEvent(res, step.value);
        if (!ok) break;

        step = await iterator.next();
        if (abort.signal.aborted) break;
      }
      done = step.done === true;

      if (!abort.signal.aborted && !res.writableEnded) {
        const ok = await writeEvent(res, { type: EVENT.DONE });
        if (ok && !res.writableEnded) res.end();
      }
    } catch (error) {
      if (!hasSentHeaders(res)) {
        // Nothing has been flushed yet: preserve the normal HTTP error path
        // (400 validation, 409 busy, 500 internal).
        if (abort.signal.aborted) return;
        return next(error);
      }

      if (abort.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }

      console.error("[gateway] agent stream failed:", error);
      try {
        const ok = await writeEvent(res, sseError(error));
        if (ok && !res.writableEnded) res.end();
      } catch {
        if (!res.writableEnded) res.end();
      }
    } finally {
      finished = true;
      req.off("aborted", onClose);
      req.off("close", onRequestClose);
      res.off("close", onClose);
      untrack();

      // Breaking out early (disconnect/backpressure) must still run the
      // generator's finally block, which commits the partial turn.
      if (iterator && !done) {
        try {
          await iterator.return();
        } catch {
          // A generator teardown failure must not mask the original error.
        }
      }
    }
  };
}

export const agentController = createAgentController();
