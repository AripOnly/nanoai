// src/services/session.js
import { gateway } from "./api.js";

async function create(promptOrOptions) {
  return gateway.createSession(promptOrOptions);
}

async function list() {
  return gateway.listSessions();
}

async function getConversation(sessionId, options = {}) {
  try {
    return await gateway.getConversation(sessionId, options);
  } catch (error) {
    console.warn(`Error API: ${error.message}`);
    throw error;
  }
}

async function getSessionInfo(sessionId) {
  try {
    return await gateway.getSessionInfo(sessionId);
  } catch (error) {
    console.warn(`Error API: ${error.message}`);
    throw error;
  }
}

export default { list, getConversation, getSessionInfo, create };
