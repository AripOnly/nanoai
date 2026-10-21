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

/**
 * Create a session. The legacy string form names the session from its prompt;
 * the object form carries channel identity, a parent/kind, and a model
 * override without changing that old call shape.
 */
export function createSession(promptOrOptions) {
  if (
    promptOrOptions !== null &&
    typeof promptOrOptions === "object" &&
    !Array.isArray(promptOrOptions)
  ) {
    const options = { ...promptOrOptions };
    const prompt =
      options.prompt ?? options.initialPrompt ?? options.initial_prompt;
    return sessionStore.createSession({
      ...options,
      name: options.name ?? (typeof prompt === "string" && prompt.trim() !== ""
        ? nameFromPrompt(prompt)
        : undefined),
      initialPrompt: prompt ?? null,
      externalRef: options.externalRef ?? options.external_ref,
      parentSessionId:
        options.parentSessionId ?? options.parent_session_id,
    });
  }
  return sessionStore.createSession(nameFromPrompt(promptOrOptions), promptOrOptions);
}

/** Map channel + external_ref to one session, creating it on first contact. */
export function resolveSession({ channel, externalRef, model = null } = {}) {
  return sessionStore.resolveSession({ channel, externalRef, model });
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

/** Backwards-paginated conversation page; `before` is a turn id cursor. */
export function getConversationPage(session_id, options = {}) {
  return sessionStore.getConversationPage(session_id, options);
}

/** Turn metadata (no conversation parts) newest-first. */
export function listTurns(session_id, options = {}) {
  return sessionStore.listTurns(session_id, options);
}

/** One turn by id, including parsed parts and usage. */
export function getTurn(turnId) {
  return sessionStore.getTurn(turnId);
}

export function findTurnByClientMessageId(session_id, clientMessageId) {
  return sessionStore.findTurnByClientMessageId(session_id, clientMessageId);
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

/** Reserve the session and durably insert the prompt (user or job notice). */
export function beginTurn(session_id, prompt, options = {}) {
  const role = options.eventRole ?? EVENT.USER;
  return sessionStore.start(session_id, role, prompt, options);
}

/** Persist (or buffer) one event produced during the active turn. */
export function recordEvent(session_id, event) {
  sessionStore.record(session_id, event);
}

/** Finalize the active turn and store token/usage accounting. */
export function commitTurn(
  session_id,
  token = null,
  usage = null,
  status = "complete",
) {
  sessionStore.commit(session_id, token, usage, status);
}

/** Fill provider/model into the turn row once the resolver has chosen them. */
export function setTurnModel(turnId, provider, model) {
  sessionStore.setTurnModel(turnId, provider, model);
}

/** Persist the per-session model override (null clears it). */
export function setSessionModel(session_id, model) {
  return sessionStore.setSessionModel(session_id, model);
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
