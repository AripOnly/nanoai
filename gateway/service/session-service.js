// gateway/service/session-service.js
//
// Session use-cases for the HTTP door. Storage is reached through the
// session module door (src/session/index.js); missing sessions surface as 404
// here (not as an undefined body with status 200), so every client sees the
// same error envelope via the error middleware.

import * as session from "../../src/session/index.js";
import { ResponseError } from "../error/response-error.js";

/** Boot-time: mark turns that a previous crash left "streaming" as aborted. */
function init() {
  return session.recoverInterruptedTurns();
}

function listSession() {
  return session.listSessions();
}

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

function requireSession(session_id) {
  if (!session.getSession(session_id)) {
    throw new ResponseError(404, `Session ${session_id} not found.`);
  }
}

function parsePositiveInteger(value, field, { max = Infinity } = {}) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new ResponseError(
      400,
      Number.isFinite(max)
        ? `${field} must be an integer between 1 and ${max}.`
        : `${field} must be a positive integer.`,
    );
  }
  return number;
}

/**
 * No pagination query keeps the legacy plain-array response. Supplying
 * `limit` and/or `before` returns one page plus an opaque older-page cursor.
 */
function getConversation(session_id, { limit, before } = {}) {
  requireSession(session_id);
  const pageLimit = parsePositiveInteger(limit, "limit", { max: 500 });
  const cursor = parsePositiveInteger(before, "before");
  if (pageLimit === null && cursor === null) {
    return session.getConversation(session_id);
  }
  return session.getConversationPage(session_id, {
    ...(pageLimit === null ? {} : { limit: pageLimit }),
    before: cursor,
  });
}

function listTurns(session_id, { limit, before } = {}) {
  requireSession(session_id);
  const pageLimit = parsePositiveInteger(limit, "limit", { max: 500 });
  const cursor = parsePositiveInteger(before, "before");
  return session.listTurns(session_id, {
    ...(pageLimit === null ? {} : { limit: pageLimit }),
    before: cursor,
  });
}

function getSessionInfo(session_id) {
  const info = session.getSessionInfo(session_id);
  if (!info) {
    throw new ResponseError(404, `Session ${session_id} not found.`);
  }
  return info;
}

function updateSession(session_id, { name, model } = {}) {
  const nextName = optionalText(name, "name", 200);
  const hasModel = model !== undefined;
  const nextModel = hasModel ? optionalText(model, "model", 256) : null;

  if (nextName === null && !hasModel) {
    throw new ResponseError(400, "name must be a non-empty string.");
  }

  requireSession(session_id);
  if (nextName !== null) {
    session.renameSession(session_id, nextName);
  }
  if (hasModel) {
    // null/"" clears the per-session override.
    session.setSessionModel(session_id, nextModel);
  }
  // A rename/model update of a session deleted concurrently still returns 404.
  return getSessionInfo(session_id);
}

function renameSession(session_id, name) {
  return updateSession(session_id, { name });
}

function deleteSession(session_id) {
  // Idempotent by design: deleting an already-gone session is success.
  session.deleteSession(session_id);
  return { deleted: true };
}

function createSession(input) {
  if (typeof input === "string") {
    if (input.trim() === "") {
      throw new ResponseError(400, "prompt must be a non-empty string.");
    }
    return session.createSession(input);
  }

  const options = input && typeof input === "object" ? input : {};
  const prompt = options.prompt;
  if (prompt !== undefined && prompt !== null) {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new ResponseError(400, "prompt must be a non-empty string.");
    }
  }

  const channel = optionalText(options.channel, "channel", 64);
  const external_ref = optionalText(
    options.external_ref,
    "external_ref",
    256,
  );
  const name = optionalText(options.name, "name", 200);
  const model = optionalText(options.model, "model", 256);
  const kind = optionalText(options.kind, "kind", 32);

  if (channel !== null && external_ref === null) {
    throw new ResponseError(
      400,
      "external_ref is required when channel is provided.",
    );
  }
  if (external_ref !== null && channel === null) {
    throw new ResponseError(
      400,
      "channel is required when external_ref is provided.",
    );
  }
  if (
    (prompt === undefined || prompt === null) &&
    channel === null &&
    name === null
  ) {
    throw new ResponseError(
      400,
      "prompt, name, or channel + external_ref is required.",
    );
  }

  try {
    return session.createSession({
      prompt: prompt ?? null,
      name,
      channel,
      externalRef: external_ref,
      model,
      kind,
    });
  } catch (error) {
    if (String(error?.code ?? "").startsWith("SQLITE_CONSTRAINT")) {
      throw new ResponseError(
        409,
        "A session with this channel identity already exists.",
      );
    }
    throw error;
  }
}

function resolveSession({ channel, external_ref, model } = {}) {
  const nextChannel = optionalText(channel, "channel", 64);
  const nextExternalRef = optionalText(
    external_ref,
    "external_ref",
    256,
  );
  const nextModel = optionalText(model, "model", 256);

  if (nextChannel === null || nextExternalRef === null) {
    throw new ResponseError(
      400,
      "channel and external_ref must be non-empty strings.",
    );
  }

  return session.resolveSession({
    channel: nextChannel,
    externalRef: nextExternalRef,
    model: nextModel,
  });
}

export default {
  init,
  listSession,
  getConversation,
  listTurns,
  getSessionInfo,
  createSession,
  resolveSession,
  updateSession,
  renameSession,
  deleteSession,
};
