// src/services/session.js
import { apiFetch } from "./api.js";

async function create(prompt) {
  const response = await apiFetch(`/session/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: prompt }),
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }

  return await response.json();
}

async function list() {
  const response = await apiFetch(`/session/list-session`);

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }

  return await response.json();
}

async function getConversation(sessionId) {
  try {
    const response = await apiFetch(`/session/${sessionId}`);

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.warn(`Error API: ${error.message}`);
    throw error;
  }
}

async function getSessionInfo(sessionId) {
  try {
    const response = await apiFetch(`/session/info/${sessionId}`);

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.warn(`Error API: ${error.message}`);
    throw error;
  }
}

export default { list, getConversation, getSessionInfo, create };
