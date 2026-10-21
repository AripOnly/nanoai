// src/llm/provider-error.js
//
// Provider error normalization. Every adapter uses the same stable taxonomy so
// the runtime/UI can distinguish auth, rate-limit, context-length, network,
// and transient server failures without parsing SDK-specific error shapes.
//
// Messages are deliberately sanitized: API keys, bearer tokens, and endpoint
// URLs never leave the adapter in an event, error, or log line.

import { EVENT } from "#src/shared/event-type.js";

export const PROVIDER_ERROR_CODES = Object.freeze({
  AUTH: "PROVIDER_AUTH_ERROR",
  RATE_LIMIT: "PROVIDER_RATE_LIMIT",
  CONTEXT: "PROVIDER_CONTEXT_ERROR",
  NETWORK: "PROVIDER_NETWORK_ERROR",
  UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  GENERIC: "PROVIDER_ERROR",
});

const AUTH_CODES = new Set([
  "authentication_error",
  "invalid_api_key",
  "invalid_api_key_error",
  "permission_denied",
  "insufficient_permissions",
  "unauthenticated",
]);

const RATE_LIMIT_CODES = new Set([
  "rate_limit_exceeded",
  "rate_limit_error",
  "insufficient_quota",
  "quota_exceeded",
  "resource_exhausted",
  "too_many_requests",
]);

const CONTEXT_CODES = new Set([
  "context_length_exceeded",
  "string_above_max_length",
  "request_too_large",
  "max_tokens_exceeded",
]);

const NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const ABORT_NAMES = new Set([
  "AbortError",
  "APIUserAbortError",
  "RequestAbortedError",
]);

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function statusOf(error) {
  const raw =
    error?.status ??
    error?.statusCode ??
    error?.response?.status ??
    error?.error?.status;
  const status = Number(raw);
  return Number.isInteger(status) ? status : null;
}

function messageOf(error) {
  if (typeof error === "string") return error;
  return firstString(
    error?.error?.message,
    error?.cause?.message,
    error?.message,
    error?.body,
  );
}

/** True for client aborts, which callers must treat as a quiet stop. */
export function isAbortError(error) {
  if (!error) return false;
  if (ABORT_NAMES.has(error.name)) return true;
  if (error.code === "ABORT_ERR" || error.code === 20) return true;
  return /request was aborted|operation was aborted|aborted by (?:the )?user/i.test(
    messageOf(error),
  );
}

/**
 * Remove credentials and endpoint URLs from a provider message. The returned
 * text is safe to emit as an event or write to a log.
 */
export function redactProviderMessage(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      text = text.split(secret).join("[redacted]");
    }
  }
  text = text.replace(/\bBearer\s+[^\s,;)]+/gi, "Bearer [redacted]");
  text = text.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  text = text.replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]");
  text = text.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization)(["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
    "$1$2[redacted]",
  );
  text = text.replace(/https?:\/\/[^\s"'`)]+/gi, "[endpoint]");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 800) {
    text = `${text.slice(0, 797)}...`;
  }
  return text;
}

/**
 * Classify an SDK/network error into the provider-neutral taxonomy.
 *
 * @param {unknown} error
 * @param {{ message?: string, secrets?: string[] }} [options]
 * @returns {{ code: string, retryable: boolean, message: string }}
 */
export function classifyProviderError(error, { message, secrets = [] } = {}) {
  const status = statusOf(error);
  const code = firstString(error?.code, error?.error?.code).toLowerCase();
  const rawMessage = firstString(message, messageOf(error)) || "Provider request failed.";
  const cleaned =
    redactProviderMessage(rawMessage, secrets) || "Provider request failed.";
  const lower = rawMessage.toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    AUTH_CODES.has(code) ||
    /unauthorized|forbidden|invalid[ _-]?api[ _-]?key|incorrect api key|authentication|permission denied|api key not valid/i.test(
      lower,
    )
  ) {
    return {
      code: PROVIDER_ERROR_CODES.AUTH,
      retryable: false,
      message: cleaned,
    };
  }

  if (
    status === 429 ||
    RATE_LIMIT_CODES.has(code) ||
    /rate[ _-]?limit|too many requests|quota|resource[ _-]?exhausted/i.test(lower)
  ) {
    return {
      code: PROVIDER_ERROR_CODES.RATE_LIMIT,
      retryable: true,
      message: cleaned,
    };
  }

  if (
    CONTEXT_CODES.has(code) ||
    /context (?:length|window)|maximum (?:context|number of tokens)|too many tokens|prompt is too long|input is too long|request too large|token limit|exceeds? (?:the )?.*context/i.test(
      lower,
    )
  ) {
    return {
      code: PROVIDER_ERROR_CODES.CONTEXT,
      retryable: false,
      message: cleaned,
    };
  }

  if (
    NETWORK_CODES.has(firstString(error?.code, error?.cause?.code).toUpperCase()) ||
    /fetch failed|network|econn|enotfound|etimedout|eai_again|socket|connection (?:reset|refused|closed)|timed out|timeout/i.test(
      lower,
    )
  ) {
    return {
      code: PROVIDER_ERROR_CODES.NETWORK,
      retryable: true,
      message: cleaned,
    };
  }

  if (status === 529 || (status !== null && status >= 500)) {
    return {
      code: PROVIDER_ERROR_CODES.UNAVAILABLE,
      retryable: true,
      message: cleaned,
    };
  }

  return {
    code: PROVIDER_ERROR_CODES.GENERIC,
    retryable: false,
    message: cleaned,
  };
}

/** Build a safe terminal provider event. Aborts are not errors. */
export function providerErrorEvent(
  error,
  { provider = null, message, secrets = [] } = {},
) {
  if (isAbortError(error)) return null;
  const classified = classifyProviderError(error, { message, secrets });
  return {
    role: EVENT.ERROR,
    content: {
      ...(provider ? { provider } : {}),
      ...classified,
    },
  };
}
