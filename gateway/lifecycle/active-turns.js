// gateway/lifecycle/active-turns.js
//
// The gateway is single-process but can hold several SSE turns at once. Keep
// their AbortControllers here so shutdown can stop provider/tool work before
// closing the database, instead of waiting for clients to disconnect.

const active = new Set();

/** Register an AbortController; returns an idempotent cleanup function. */
export function trackActiveTurn(controller) {
  if (!controller || typeof controller.abort !== "function") {
    throw new TypeError("trackActiveTurn requires an AbortController.");
  }
  active.add(controller);
  return () => {
    active.delete(controller);
  };
}

/** Abort every in-flight turn. Safe to call more than once. */
export function abortActiveTurns(reason = new Error("Gateway shutting down")) {
  for (const controller of [...active]) {
    if (controller.signal?.aborted) continue;
    try {
      controller.abort(reason);
    } catch {
      // A broken controller must not prevent the rest from aborting.
    }
  }
  active.clear();
}
