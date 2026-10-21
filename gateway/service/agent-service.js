// gateway/service/agent-service.js
//
// Validation lives here, not in the controller: the service owns the business
// rule of which agents exist, whether a session is already busy, and how a
// request must look. agentService() validates synchronously (so the controller
// can still answer with a plain HTTP error) and returns the event stream to
// consume. The stream wrapper maps a race-time SessionBusyError to 409 too.

import { hasAgent, listAgentNames } from "../../src/agents/index.js";
import {
  isSessionBusy,
  SessionBusyError,
} from "../../src/session/index.js";
import { ResponseError } from "../error/response-error.js";

function optionalText(value, field, max = 256) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ResponseError(400, `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) {
    throw new ResponseError(
      400,
      `${field} must be at most ${max} characters.`,
    );
  }
  return trimmed;
}

export function agentService(request = {}, { signal, runtime } = {}) {
  const { name, prompt } = request;

  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new ResponseError(400, "prompt must be a non-empty string.");
  }

  if (!hasAgent(name)) {
    throw new ResponseError(
      400,
      `Unknown agent "${name}". Available agents: ${listAgentNames().join(", ")}.`,
    );
  }

  const session_id = optionalText(request.session_id, "session_id");
  const channel = optionalText(request.channel, "channel", 64);
  const external_ref = optionalText(
    request.external_ref,
    "external_ref",
    256,
  );
  const client_message_id = optionalText(
    request.client_message_id,
    "client_message_id",
    256,
  );
  const model = optionalText(request.model, "model", 256);

  if (session_id !== null && (channel !== null || external_ref !== null)) {
    throw new ResponseError(
      400,
      "Provide either session_id or channel + external_ref, not both.",
    );
  }

  if (session_id === null && (channel === null || external_ref === null)) {
    throw new ResponseError(
      400,
      "session_id or channel + external_ref is required.",
    );
  }

  if (isSessionBusy(session_id)) {
    throw new ResponseError(
      409,
      `Session ${session_id} already has an active turn.`,
    );
  }

  return runAgent({
    name,
    prompt,
    session_id,
    channel,
    external_ref,
    client_message_id,
    model,
    signal,
    runtime,
  });
}

async function* runAgent({
  name,
  prompt,
  session_id,
  channel,
  external_ref,
  client_message_id,
  model,
  signal,
  runtime,
}) {
  if (!runtime || typeof runtime.runTurn !== "function") {
    throw new ResponseError(500, "Agent runtime is not configured.");
  }

  try {
    yield* runtime.runTurn({
      name,
      prompt,
      session_id,
      channel,
      external_ref,
      client_message_id,
      model,
      signal,
    });
  } catch (error) {
    // The preflight above handles the normal case. This catches the tiny
    // window where two requests pass the preflight before either reserves
    // the session; runTurn rethrows SessionBusyError for exactly this path.
    if (error instanceof SessionBusyError) {
      throw new ResponseError(409, error.message);
    }
    throw error;
  }
}
