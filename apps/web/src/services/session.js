// src/services/session.js
const baseUrl = "http://localhost:3060/api/v1";

async function create(prompt) {
  const url = `${baseUrl}/session/`;

  const response = await fetch(url, {
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
  try {
    const url = `${baseUrl}/session/list-session`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.warn(`Error API: ${error.message}`);
    throw error;
  }
}

async function getHistory(sessionId) {
  try {
    const url = `${baseUrl}/session/${sessionId}`;

    const response = await fetch(url);

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
    const url = `${baseUrl}/session/info/${sessionId}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.warn(`Error API: ${error.message}`);
    throw error;
  }
}

export default { list, getHistory, getSessionInfo, create };
