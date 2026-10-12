// src/tools/web/mcp.js
//
// Minimal JSON-RPC client for the MCP search providers opencode uses
// (read-only reference: packages/opencode/src/tool/mcp-websearch.ts and
// the provider wiring in websearch.ts).
//
// Providers:
// - Exa (web_search_exa): balanced/deep/fast search with live crawling.
// - Parallel (web_search): agentic search driven by an objective.
// Both expose an MCP endpoint that answers JSON-RPC tools/call over HTTP,
// either as a single JSON body or as Server-Sent Events.

const EXA_URL = process.env.EXA_API_KEY
  ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
  : "https://mcp.exa.ai/mcp";
const PARALLEL_URL = "https://search.parallel.ai/mcp";

// Same 25 second budget as opencode: search must stay interactive.
const PROVIDER_TIMEOUT_MS = 25_000;


/**
 * Extract the first text payload from an MCP response body, which arrives
 * either as one JSON document or as SSE `data:` lines. Pure function,
 * unit-tested with fixtures (no network needed).
 */
export function parseMcpResponse(body) {
  if (typeof body !== "string") return undefined;
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    const direct = payloadText(trimmed);
    if (direct) return direct;
  }
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const text = payloadText(line.substring(6));
    if (text) return text;
  }
  return undefined;
}

function payloadText(payload) {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const content = json?.result?.content;
  if (!Array.isArray(content)) return undefined;
  const item = content.find((entry) => entry && typeof entry.text === "string" && entry.text.length > 0);
  return item ? item.text : undefined;
}

/**
 * Call one MCP tool and return its text result. Throws a plain Error with a
 * clear message on transport, timeout, or protocol failures.
 */
export async function callMcpTool({ url, tool, args, timeoutMs = PROVIDER_TIMEOUT_MS, headers = {}, signal }) {
  if (typeof url !== "string" || url === "") throw new Error("MCP URL must be a non-empty string.");
  if (typeof tool !== "string" || tool === "") throw new Error("MCP tool name must be a non-empty string.");

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      signal: combined,
    });
  } catch (error) {
    // A user abort must not masquerade as a timeout: report it as such so
    // callers (and the model) know the difference.
    if (signal?.aborted || error?.name === "AbortError") {
      throw new Error(`${tool} request was aborted.`);
    }
    if (error?.name === "TimeoutError") {
      throw new Error(`${tool} request timed out after ${timeoutMs} ms.`);
    }
    throw new Error(`${tool} request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`${tool} request failed with HTTP ${response.status}.`);
  }
  const body = await response.text();
  const text = parseMcpResponse(body);
  if (!text) {
    throw new Error(`${tool} returned an unreadable response. Try a different query.`);
  }
  return text;
}

// Deterministic 50/50 split so one session sticks to one provider.
// Any stable string hash works; exact opencode checksum parity is unnecessary.
function hashSession(sessionID) {
  let hash = 0;
  for (let i = 0; i < sessionID.length; i++) {
    hash = (hash * 31 + sessionID.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Pick a search provider: explicit NANO_WEBSEARCH_PROVIDER override first,
 * otherwise a stable per-session split (same idea as opencode's checksum).
 */
export function selectProvider(sessionID) {
  const override = process.env.NANO_WEBSEARCH_PROVIDER;
  if (override === "exa" || override === "parallel") return override;
  if (typeof sessionID !== "string" || sessionID === "") return "exa";
  return hashSession(sessionID) % 2 === 0 ? "exa" : "parallel";
}

export function providerLabel(provider) {
  if (provider === "parallel") return "Parallel Web Search";
  if (provider === "exa") return "Exa Web Search";
  return "Web Search";
}

/**
 * Full-text search via Exa: LLM-optimized content from the most relevant
 * pages, not just snippets.
 */
export async function searchExa(query, options = {}, context = {}) {
  return callMcpTool({
    url: EXA_URL,
    tool: "web_search_exa",
    args: {
      query,
      type: options.type ?? "auto",
      numResults: options.numResults ?? 8,
      livecrawl: options.livecrawl ?? "fallback",
      ...(options.contextMaxCharacters !== undefined
        ? { contextMaxCharacters: options.contextMaxCharacters }
        : {}),
    },
    headers: {},
    signal: context.signal,
  });
}

/**
 * Agentic search via Parallel: driven by an objective instead of keywords.
 */
export async function searchParallel(query, context = {}) {
  const headers = { "User-Agent": "nano-agent/1.0" };
  return callMcpTool({
    url: PARALLEL_URL,
    tool: "web_search",
    args: {
      objective: query,
      search_queries: [query],
      ...(typeof context.sessionID === "string" && context.sessionID !== "" ? { session_id: context.sessionID } : {}),
    },
    headers,
    signal: context.signal,
  });
}

