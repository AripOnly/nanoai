// apps/cli/lib/api.js
// HTTP client for the NanoAI gateway. The CLI runs on the same machine, so it
// reads the gateway token from the local settings file instead of asking
// the user to paste it.
import { settings } from "../../../src/config/config.js";

const PORT = process.env.PORT ?? "3060";
const BASE_URL = process.env.NANO_GATEWAY_URL ?? `http://localhost:${PORT}/api/v1`;

function connectionError() {
  return new Error(
    `Cannot reach the gateway at ${BASE_URL}. Start it first with: node gateway/server.js`,
  );
}

let cachedToken = null;

async function gatewayToken() {
  if (cachedToken) {
    return cachedToken;
  }

  let token = null;
  try {
    token = await settings.get("gateway_token");
  } catch {
    token = null;
  }

  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      "Gateway token not found. Start the gateway once (node gateway/server.js) so it generates one.",
    );
  }

  cachedToken = token;
  return token;
}

async function request(path, options = {}) {
  const token = await gatewayToken();
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers ?? {}),
      },
    });
  } catch {
    throw connectionError();
  }

  if (response.status === 401) {
    cachedToken = null;
    throw new Error(
      "Gateway unauthorized (401). The stored token is wrong or stale.",
    );
  }

  if (!response.ok) {
    let message = `API request failed: ${response.status}`;
    try {
      const body = await response.json();
      if (body?.content?.message) {
        message = body.content.message;
      }
    } catch {
      // Keep the status-based message.
    }
    throw new Error(message);
  }

  return response.json();
}

async function* sse(path, body) {
  const token = await gatewayToken();
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw connectionError();
  }

  if (response.status === 401) {
    cachedToken = null;
    throw new Error(
      "Gateway unauthorized (401). The stored token is wrong or stale.",
    );
  }

  if (!response.ok || !response.body) {
    throw new Error(`API request failed: ${response.status}`);
  }

  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    buffer = buffer.replace(/\r\n/g, "\n");
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const rawEvent of events) {
      const event = rawEvent.trim();
      if (!event.startsWith("data: ")) continue;
      try {
        yield JSON.parse(event.slice(6).trim());
      } catch {
        // Skip unparseable heartbeat or malformed chunk.
      }
    }
  }

  const trailing = buffer.replace(/\r\n/g, "\n").trim();
  if (trailing.startsWith("data: ")) {
    try {
      yield JSON.parse(trailing.slice(6).trim());
    } catch {
      // Ignore
    }
  }
}

export const api = {
  listSessions: () => request("/session/list-session"),
  getConversation: (sessionId) => request(`/session/${sessionId}`),
  getSessionInfo: (sessionId) => request(`/session/info/${sessionId}`),
  createSession: (prompt) =>
    request("/session/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }),
  renameSession: (sessionId, name) =>
    request(`/session/${sessionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  deleteSession: (sessionId) =>
    request(`/session/${sessionId}`, { method: "DELETE" }),
  getSettings: () => request("/settings/"),
  listProviders: () => request("/settings/providers"),
  updateModel: (model) =>
    request("/settings/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    }),
  updateProviderKeys: (providerKeys) =>
    request("/settings/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_keys: providerKeys }),
    }),
  streamAgent: (payload) => sse("/agent", payload),
};
