// test/contracts/provider-error.test.js
//
// Stable provider error taxonomy and secret/endpoint redaction. No SDK or
// network access.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_ERROR_CODES,
  classifyProviderError,
  isAbortError,
  providerErrorEvent,
  redactProviderMessage,
} from "../../src/llm/provider-error.js";
import { EVENT } from "../../src/shared/event-type.js";

describe("provider error taxonomy", () => {
  it("classifies auth failures and redacts keys and endpoint URLs", () => {
    const error = {
      status: 401,
      message:
        "Incorrect API key provided: sk-live-secret-123 at https://api.example.test/v1",
    };
    const classified = classifyProviderError(error);

    assert.equal(classified.code, PROVIDER_ERROR_CODES.AUTH);
    assert.equal(classified.retryable, false);
    assert.equal(classified.message.includes("sk-live-secret-123"), false);
    assert.equal(classified.message.includes("api.example.test"), false);
    assert.match(classified.message, /\[redacted\]/);
  });

  it("classifies rate limit, context, network, unavailable, and generic failures", () => {
    assert.equal(
      classifyProviderError({ status: 429, message: "Too many requests" }).code,
      PROVIDER_ERROR_CODES.RATE_LIMIT,
    );
    assert.equal(
      classifyProviderError({ code: "insufficient_quota" }).code,
      PROVIDER_ERROR_CODES.RATE_LIMIT,
    );
    assert.equal(
      classifyProviderError({
        message: "This model's maximum context length is 128000 tokens",
      }).code,
      PROVIDER_ERROR_CODES.CONTEXT,
    );
    assert.equal(
      classifyProviderError({ code: "ECONNRESET", message: "socket closed" }).code,
      PROVIDER_ERROR_CODES.NETWORK,
    );
    assert.equal(
      classifyProviderError({ status: 503, message: "upstream overloaded" }).code,
      PROVIDER_ERROR_CODES.UNAVAILABLE,
    );
    assert.equal(
      classifyProviderError({ status: 400, message: "bad request" }).code,
      PROVIDER_ERROR_CODES.GENERIC,
    );
  });

  it("marks only transient failures retryable", () => {
    assert.equal(classifyProviderError({ status: 429 }).retryable, true);
    assert.equal(classifyProviderError({ status: 503 }).retryable, true);
    assert.equal(classifyProviderError({ code: "ETIMEDOUT" }).retryable, true);
    assert.equal(classifyProviderError({ status: 401 }).retryable, false);
    assert.equal(
      classifyProviderError({ message: "context length exceeded" }).retryable,
      false,
    );
    assert.equal(classifyProviderError({ status: 400 }).retryable, false);
  });

  it("treats client aborts as a quiet stop, not an error event", () => {
    const aborted = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    assert.equal(isAbortError(aborted), true);
    assert.equal(providerErrorEvent(aborted), null);

    assert.equal(isAbortError(new Error("boom")), false);
    assert.equal(providerErrorEvent(new Error("boom")).role, EVENT.ERROR);
  });

  it("builds a safe terminal event with the provider id", () => {
    const event = providerErrorEvent(
      { status: 401, message: "bad key AIza123456789012345678901234567890" },
      { provider: "google" },
    );
    assert.equal(event.role, EVENT.ERROR);
    assert.equal(event.content.provider, "google");
    assert.equal(event.content.code, PROVIDER_ERROR_CODES.AUTH);
    assert.equal(event.content.message.includes("AIza123456789012345678901234567890"), false);
  });

  it("redacts an exact configured secret even without a recognizable prefix", () => {
    const secret = "custom_credential_ABC123";
    const classified = classifyProviderError(
      { status: 401, message: `credential rejected: ${secret}` },
      { secrets: [secret] },
    );
    assert.equal(classified.message.includes(secret), false);
    assert.match(classified.message, /\[redacted\]/);

    const event = providerErrorEvent(new Error(`bad key ${secret}`), {
      provider: "custom",
      secrets: [secret],
    });
    assert.equal(event.content.message.includes(secret), false);
    assert.match(event.content.message, /\[redacted\]/);
  });

  it("redacts bearer tokens, api-key assignments, and URLs", () => {
    const safe = redactProviderMessage(
      'Authorization: Bearer abc.def.ghi api_key="super-secret" endpoint=https://private.example/v1',
    );
    assert.equal(safe.includes("abc.def.ghi"), false);
    assert.equal(safe.includes("super-secret"), false);
    assert.equal(safe.includes("private.example"), false);
  });
});
