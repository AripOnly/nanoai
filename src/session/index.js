// src/session/index.js
//
// The module door for session storage — the single owner of the SQLite file.
// Outer layers (gateway, apps) call these named use-cases, never the store
// object and never sql.js, so the internals stay swappable.

import sql from "./sql.js";
import { sessionStore, nameFromPrompt } from "./session-store.js";
import { EVENT } from "#src/shared/event-type.js";

export { STORAGE_DIR, closeDatabase } from "./sql.js";
export { SessionBusyError } from "./session-store.js";

/** Cheap database readiness probe: one trivial query. Throws when the DB is gone. */
export function ping() {
  sql.prepare("SELECT 1").get();
}

/** Is a turn currently streaming in this process for the session? */
export function isSessionBusy(session_id) {
  if (typeof session_id !== "string" || session_id.trim() === "") {
    return false;
  }
  return sessionStore.isActive(session_id);
}

/** Create a session and name it from its first prompt. */
export function createSession(prompt) {
  return sessionStore.createSession(nameFromPrompt(prompt), prompt);
}

export function listSessions() {
  return sessionStore.listSessions();
}

/** Full session row (token, summary, name) or undefined when missing. */
export function getSession(session_id) {
  return sessionStore.getSessionById(session_id);
}

/** Header-safe session info (no conversation/state) or undefined when missing. */
export function getSessionInfo(session_id) {
  return sessionStore.getSessionInfo(session_id);
}

export function getConversation(session_id) {
  return sessionStore.getConversation(session_id);
}

export function renameSession(session_id, name) {
  sessionStore.renameSession(session_id, name);
}

export function deleteSession(session_id) {
  sessionStore.deleteSession(session_id);
}

/** Boot-time cleanup: mark turns interrupted by a crash as aborted. */
export function recoverInterruptedTurns(options = {}) {
  if (options && typeof options === "object" && "session_id" in options) {
    return sessionStore.recoverInterruptedTurns(options.session_id, options);
  }
  return sessionStore.recoverAllInterruptedTurns(options);
}

/** Per-session recovery used by the runtime before a new turn starts. */
export function recoverInterruptedTurn(session_id) {
  return sessionStore.recoverInterruptedTurns(session_id);
}

/** Reserve the session and durably insert the user prompt. */
export function beginTurn(session_id, prompt) {
  sessionStore.start(session_id, EVENT.USER, prompt);
}

/** Persist (or buffer) one event produced during the active turn. */
export function recordEvent(session_id, event) {
  sessionStore.record(session_id, event);
}

/** Finalize the active turn and store the latest token accounting. */
export function commitTurn(session_id, token = null) {
  sessionStore.commit(session_id, token);
}

/** Latest stored compaction summary for a session. */
export function getSummary(session_id) {
  return sessionStore.getSummary(session_id);
}

/** Persist a compaction summary for a session. */
export function compactSession(session_id, summary) {
  sessionStore.compact(session_id, summary);
}

/** Trim history before the last N user turns; see the store implementation. */
export function pruneConversation(conversation, keepTurn) {
  return sessionStore.pruneConversation(conversation, keepTurn);
}

/** Name a still-auto-named session from its first real prompt. */
export function autoNameSession(session_id, prompt) {
  return sessionStore.autoNameSession(session_id, prompt);
}
