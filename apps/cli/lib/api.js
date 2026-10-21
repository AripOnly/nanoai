// apps/cli/lib/api.js
// HTTP client for the NanoAI gateway. The CLI runs on the same machine, so it
// reads the gateway token from the local settings file instead of asking
// the user to paste it. Transport and SSE framing live in the shared client,
// the same code the browser uses.
import { settings } from "#src/config/config.js";
import {
  createGatewayClient,
  isGatewayConnectionError,
} from "#client";

const PORT = process.env.PORT ?? "3060";
const BASE_URL = process.env.NANO_GATEWAY_URL ?? `http://localhost:${PORT}/api/v1`;

let cachedToken = null;

async function gatewayToken() {
  if (cachedToken) return cachedToken;

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

const client = createGatewayClient({
  baseUrl: BASE_URL,
  getToken: gatewayToken,
});

function normalize(error) {
  if (error?.status === 401) {
    cachedToken = null;
    return new Error(
      "Gateway unauthorized (401). The stored token is wrong or stale.",
    );
  }
  return error;
}

async function call(operation) {
  try {
    return await operation();
  } catch (error) {
    throw normalize(error);
  }
}

async function health() {
  // Public probe (no token): liveness AND readiness. True = serving.
  try {
    const result = await client.health();
    return result?.status !== "error";
  } catch {
    return false;
  }
}

export function isConnectionError(error) {
  return (
    isGatewayConnectionError(error) ||
    String(error?.message ?? "").startsWith("Cannot reach the gateway")
  );
}

export const api = {
  health,
  listSessions: () => call(() => client.listSessions()),
  getConversation: (sessionId, options = {}) =>
    call(() => client.getConversation(sessionId, options)),
  listTurns: (sessionId, options = {}) =>
    call(() => client.listTurns(sessionId, options)),
  getSessionInfo: (sessionId) =>
    call(() => client.getSessionInfo(sessionId)),
  createSession: (input) => call(() => client.createSession(input)),
  renameSession: (sessionId, name) =>
    call(() => client.renameSession(sessionId, name)),
  updateSession: (sessionId, changes) =>
    call(() => client.updateSession(sessionId, changes)),
  setSessionModel: (sessionId, model) =>
    call(() => client.setSessionModel(sessionId, model)),
  deleteSession: (sessionId) =>
    call(() => client.deleteSession(sessionId)),
  getSettings: () => call(() => client.getSettings()),
  listProviders: () => call(() => client.listProviders()),
  updateModel: (model) => call(() => client.updateModel(model)),
  updateProviderKeys: (providerKeys) =>
    call(() => client.updateProviderKeys(providerKeys)),
  async *streamAgent(payload) {
    try {
      yield* client.streamAgent(payload);
    } catch (error) {
      throw normalize(error);
    }
  },
};
