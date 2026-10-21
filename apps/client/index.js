// apps/client/index.js
//
// Shared HTTP + SSE client for every NanoAI door. It is deliberately
// environment-neutral: Node (the CLI) supplies a settings-backed token,
// the browser supplies localStorage, and both use the same fetch/stream code.
//
// The client never reads credentials from a global. Tokens are injected as a
// value or a callback, and the base URL is always explicit.

export class GatewayError extends Error {
  constructor(message, { status = null, code = null, body = null, cause } = {}) {
    super(message, { cause });
    this.name = "GatewayError";
    this.status = status;
    this.code = code ?? (status === 401 ? "UNAUTHORIZED" : "GATEWAY_ERROR");
    this.body = body;
  }
}

export function isGatewayConnectionError(error) {
  return error?.code === "GATEWAY_UNREACHABLE";
}

export function isGatewayAuthError(error) {
  return error?.status === 401 || error?.code === "UNAUTHORIZED";
}

function trimBaseUrl(baseUrl) {
  const value =
    typeof baseUrl === "string" && baseUrl.trim() !== ""
      ? baseUrl.trim()
      : "http://localhost:3060/api/v1";
  return value.replace(/\/+$/, "");
}

function encode(value) {
  return encodeURIComponent(String(value));
}

function queryString({ limit, before } = {}) {
  const params = new URLSearchParams();
  if (limit !== undefined && limit !== null && limit !== "") {
    params.set("limit", String(limit));
  }
  if (before !== undefined && before !== null && before !== "") {
    params.set("before", String(before));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** Parse one SSE frame. Comment-only frames and malformed JSON are ignored. */
function parseFrame(frame) {
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length === 0) return null;
  const text = data.join("\n");
  if (text === "[DONE]") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Incremental SSE reader. Handles frames split across chunks and CRLF/LF
 * equally. `body` is any Web ReadableStream.
 */
export async function* parseSSEStream(body, { signal } = {}) {
  if (!body || typeof body.getReader !== "function") {
    throw new GatewayError("The gateway returned an empty response body.", {
      code: "EMPTY_STREAM",
    });
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  try {
    while (!finished) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(value, { stream: true });
      }

      while (true) {
        const separator = buffer.match(/\r?\n\r?\n/);
        if (!separator) break;
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const event = parseFrame(frame);
        if (event) yield event;
      }
    }

    if (buffer.trim() !== "") {
      const event = parseFrame(buffer);
      if (event) yield event;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Cancellation is best effort; the caller still gets the stream error.
    }
  }
}

export function createGatewayClient({
  baseUrl,
  token = null,
  getToken = null,
  fetchImpl = globalThis.fetch,
  headers: defaultHeaders = {},
  timeoutMs = 0,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createGatewayClient requires a fetch implementation.");
  }

  const root = trimBaseUrl(baseUrl);

  async function authToken() {
    const value =
      typeof getToken === "function" ? await getToken() : token;
    return typeof value === "string" && value !== "" ? value : null;
  }

  async function buildInit({
    method = "GET",
    body,
    signal,
    auth = true,
    headers = {},
  } = {}) {
    const nextHeaders = { ...defaultHeaders, ...headers };
    const isFormData =
      typeof FormData !== "undefined" && body instanceof FormData;
    if (body !== undefined && !isFormData) {
      nextHeaders["Content-Type"] ??= "application/json";
    }
    if (auth) {
      const value = await authToken();
      if (value) nextHeaders.Authorization = `Bearer ${value}`;
    }

    let controller = null;
    let timeout = null;
    if (timeoutMs > 0 && !signal) {
      controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);
    }

    return {
      init: {
        method,
        headers: nextHeaders,
        body:
          body === undefined || typeof body === "string"
            ? body
            : JSON.stringify(body),
        signal: signal ?? controller?.signal,
      },
      cleanup: () => {
        if (timeout) clearTimeout(timeout);
      },
    };
  }

  async function fetchResponse(url, options) {
    const { init, cleanup } = await buildInit(options);
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new GatewayError(
        `Cannot reach the NanoAI gateway at ${root}. Start it with: node gateway/server.js`,
        {
          code: "GATEWAY_UNREACHABLE",
          cause: error,
        },
      );
    } finally {
      cleanup();
    }
  }

  async function parseError(response) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const message =
      body?.content?.message ??
      body?.message ??
      `Gateway request failed with HTTP ${response.status}.`;
    const code =
      body?.code ?? (response.status === 401 ? "UNAUTHORIZED" : "HTTP_ERROR");
    return new GatewayError(message, {
      status: response.status,
      code,
      body,
    });
  }

  async function request(path, options = {}) {
    const response = await fetchResponse(`${root}${path}`, options);
    if (!response.ok) throw await parseError(response);
    if (response.status === 204) return null;
    const text = await response.text();
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new GatewayError("The gateway returned invalid JSON.", {
        status: response.status,
        code: "INVALID_JSON",
      });
    }
  }

  async function* stream(path, { body, signal } = {}) {
    const response = await fetchResponse(`${root}${path}`, {
      method: "POST",
      body,
      signal,
      headers: { Accept: "text/event-stream" },
    });
    if (!response.ok) throw await parseError(response);
    yield* parseSSEStream(response.body, { signal });
  }

  return Object.freeze({
    baseUrl: root,

    listSessions() {
      return request("/session/list-session");
    },

    getSessionInfo(sessionId) {
      return request(`/session/info/${encode(sessionId)}`);
    },

    getConversation(sessionId, options = {}) {
      return request(`/session/${encode(sessionId)}${queryString(options)}`);
    },

    listTurns(sessionId, options = {}) {
      return request(
        `/session/${encode(sessionId)}/turns${queryString(options)}`,
      );
    },

    createSession(input) {
      const body =
        typeof input === "string" ? { prompt: input } : (input ?? {});
      return request("/session/", { method: "POST", body });
    },

    resolveSession({ channel, external_ref: externalRef, model } = {}) {
      return request("/session/resolve", {
        method: "POST",
        body: { channel, external_ref: externalRef, model },
      });
    },

    updateSession(sessionId, changes) {
      return request(`/session/${encode(sessionId)}`, {
        method: "PUT",
        body: changes,
      });
    },

    renameSession(sessionId, name) {
      return request(`/session/${encode(sessionId)}`, {
        method: "PUT",
        body: { name },
      });
    },

    setSessionModel(sessionId, model) {
      return request(`/session/${encode(sessionId)}`, {
        method: "PUT",
        body: { model },
      });
    },

    deleteSession(sessionId) {
      return request(`/session/${encode(sessionId)}`, { method: "DELETE" });
    },

    getSettings() {
      return request("/settings/");
    },

    listProviders() {
      return request("/settings/providers");
    },

    updateSettings(changes) {
      return request("/settings/", { method: "PUT", body: changes });
    },

    updateModel(model) {
      return request("/settings/", { method: "PUT", body: { model } });
    },

    updateProviderKeys(providerKeys) {
      return request("/settings/", {
        method: "PUT",
        body: { provider_keys: providerKeys },
      });
    },

    streamAgent(input, { signal } = {}) {
      return stream("/agent", { body: input, signal });
    },

    async health() {
      let healthBase = root;
      try {
        healthBase = new URL(root).origin;
      } catch {
        healthBase = root.replace(/\/api\/v1$/, "");
      }
      const response = await fetchResponse(`${healthBase}/health`, {
        auth: false,
      });
      if (!response.ok) throw await parseError(response);
      return response.json();
    },
  });
}
