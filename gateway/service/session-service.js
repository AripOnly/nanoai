// gateway/service/session-service.js

import {
  sessionStore,
  nameFromPrompt,
} from "../../src/session/session-store.js";

function listSession() {
  return sessionStore.listSessions();
}

function getHistory(session_id) {
  return sessionStore.getHistory(session_id);
}

function getSessionInfo(session_id) {
  return sessionStore.getSessionInfo(session_id);
}

function createSession(prompt) {
  const name = nameFromPrompt(prompt);
  return sessionStore.createSession(name, prompt);
}

export default { listSession, getHistory, getSessionInfo, createSession };
