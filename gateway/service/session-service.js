// gateway/service/session-service.js

import {
  sessionStore,
  nameFromPrompt,
} from "../../src/session/session-store.js";
import { ResponseError } from "../error/response-error.js";

function listSession() {
  return sessionStore.listSessions();
}

function getConversation(session_id) {
  return sessionStore.getConversation(session_id);
}

function getSessionInfo(session_id) {
  return sessionStore.getSessionInfo(session_id);
}

function renameSession(session_id, name) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new ResponseError(400, "name must be a non-empty string.");
  }
  sessionStore.renameSession(session_id, name);
  return sessionStore.getSessionInfo(session_id);
}

function deleteSession(session_id) {
  sessionStore.deleteSession(session_id);
  return { deleted: true };
}

function createSession(prompt) {
  const name = nameFromPrompt(prompt);
  return sessionStore.createSession(name, prompt);
}

export default { listSession, getConversation, getSessionInfo, createSession, renameSession, deleteSession };
