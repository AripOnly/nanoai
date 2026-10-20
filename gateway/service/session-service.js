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

function getConversation(session_id) {
  if (!session.getSession(session_id)) {
    throw new ResponseError(404, `Session ${session_id} not found.`);
  }
  return session.getConversation(session_id);
}

function getSessionInfo(session_id) {
  const info = session.getSessionInfo(session_id);
  if (!info) {
    throw new ResponseError(404, `Session ${session_id} not found.`);
  }
  return info;
}

function renameSession(session_id, name) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new ResponseError(400, "name must be a non-empty string.");
  }
  session.renameSession(session_id, name);
  // A rename of a missing session updates nothing; getSessionInfo then
  // throws 404 — one existence check, no silent success.
  return getSessionInfo(session_id);
}

function deleteSession(session_id) {
  // Idempotent by design: deleting an already-gone session is success.
  session.deleteSession(session_id);
  return { deleted: true };
}

function createSession(prompt) {
  return session.createSession(prompt);
}

export default {
  init,
  listSession,
  getConversation,
  getSessionInfo,
  createSession,
  renameSession,
  deleteSession,
};
