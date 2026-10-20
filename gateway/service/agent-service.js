// gateway/service/agent-service.js
//
// Validation lives here, not in the controller: the service owns the business
// rule of which agents exist, whether a session is already busy, and how a
// request must look. agentService() validates synchronously (so the controller
// can still answer with a plain HTTP error) and returns the event stream to
// consume. The stream wrapper maps a race-time SessionBusyError to 409 too.

import { agent, hasAgent, listAgentNames } from "../../src/agents/index.js";
import {
  isSessionBusy,
  SessionBusyError,
} from "../../src/session/index.js";
import { ResponseError } from "../error/response-error.js";

export function agentService(request = {}, { signal } = {}) {
  const { name, prompt, session_id } = request;

  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new ResponseError(400, "prompt must be a non-empty string.");
  }

  if (!hasAgent(name)) {
    throw new ResponseError(
      400,
      `Unknown agent "${name}". Available agents: ${listAgentNames().join(", ")}.`,
    );
  }

  if (isSessionBusy(session_id)) {
    throw new ResponseError(
      409,
      `Session ${session_id} already has an active turn.`,
    );
  }

  return runAgent({ name, prompt, session_id, signal });
}

async function* runAgent({ name, prompt, session_id, signal }) {
  try {
    yield* agent({ name, prompt, session_id, signal });
  } catch (error) {
    // The preflight above handles the normal case. This catches the tiny
    // window where two requests pass the preflight before either reserves
    // the session; agent() rethrows SessionBusyError for exactly this path.
    if (error instanceof SessionBusyError) {
      throw new ResponseError(409, error.message);
    }
    throw error;
  }
}
