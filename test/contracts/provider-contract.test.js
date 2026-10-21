// test/contracts/provider-contract.test.js
//
// Locks the adapter surface the agent core is allowed to see. Google is
// inspected structurally and its non-network failure paths are exercised; no
// API call is made.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderContractError,
  assertProviderContract,
  providerSupportsWire,
} from "../../src/llm/provider-contract.js";
import { getProvider } from "../../src/llm/registry.js";
import { EVENT } from "../../src/shared/event-type.js";
import { createFakeProvider } from "../helpers/fake-provider.js";

function validProvider(overrides = {}) {
  return {
    id: "fake",
    supportedWires: ["fake-wire"],
    configure() {
      return this;
    },
    request: async function* request() {},
    continue() {
      return [];
    },
    dispose() {},
    ...overrides,
  };
}

function contractError(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ProviderContractError, error?.stack);
    return error.message;
  }
  assert.fail("expected ProviderContractError");
}

describe("provider contract", () => {
  it("accepts a complete adapter", () => {
    const fake = createFakeProvider();
    assert.equal(assertProviderContract("fake", fake), fake);
    assert.equal(providerSupportsWire(fake, "fake-wire"), true);
    assert.equal(providerSupportsWire(fake, "other"), false);
  });

  it("requires id, wires, configure, request, continue, and dispose", () => {
    assert.match(contractError(() => assertProviderContract("", validProvider())), /non-empty string/);
    assert.match(
      contractError(() => assertProviderContract("fake", validProvider({ id: "other" }))),
      /matching id/,
    );
    assert.match(
      contractError(() => assertProviderContract("fake", validProvider({ supportedWires: [] }))),
      /supportedWires/,
    );
    assert.match(
      contractError(() => assertProviderContract("fake", validProvider({ configure: undefined }))),
      /configure/,
    );
    assert.match(
      contractError(() => assertProviderContract("fake", validProvider({ request: undefined }))),
      /request/,
    );
    assert.match(
      contractError(() => assertProviderContract("fake", validProvider({ continue: undefined }))),
      /continue/,
    );
    assert.match(
      contractError(() => assertProviderContract("fake", validProvider({ dispose: undefined }))),
      /dispose/,
    );
    assert.match(
      contractError(() => assertProviderContract("fake", validProvider({ models: [] }))),
      /must not expose a model catalog/,
    );
  });

  it("does not let a feed-only legacy adapter register as complete", () => {
    const legacy = validProvider({
      continue: undefined,
      feed() {
        return [];
      },
    });
    assert.match(
      contractError(() => assertProviderContract("fake", legacy)),
      /continue/,
    );
  });
});

describe("google adapter", () => {
  it("declares only its wire and no model catalog", () => {
    const google = getProvider("google");
    assert.equal(google.id, "google");
    assert.deepEqual(google.supportedWires, ["google-interactions"]);
    assert.equal(google.models, undefined);
    assert.equal(providerSupportsWire(google, "google-interactions"), true);
    assert.equal(providerSupportsWire(google, "openai-chat"), false);
  });

  it("reports a clear error when used without configuration", async () => {
    const google = getProvider("google");
    google.dispose();

    const events = [];
    for await (const event of google.request({
      model: { id: "gemini-test" },
      instruction: "test",
      input: [],
      tools: [],
      sentAttachments: [],
    })) {
      events.push(event);
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].role, EVENT.ERROR);
    assert.match(events[0].content.message, /not configured/);
  });

  it("refuses an empty key and can be disposed idempotently", () => {
    const google = getProvider("google");
    assert.throws(() => google.configure({}), /requires an API key/);
    assert.throws(
      () => google.configure({ credentials: { apiKey: "   " } }),
      /requires an API key/,
    );

    google.configure({ credentials: { apiKey: "test-key" } });
    google.dispose();
    google.dispose();
  });

  it("maps provider continuation parts without exposing credentials", () => {
    const google = getProvider("google");
    const parts = google.continue({
      reasoningSignature: "sig-1",
      toolCall: [
        { call_id: "call-1", name: "read", arguments: { path: "a.txt" } },
        { call_id: "call-2", name: "grep", arguments: { pattern: "x" } },
      ],
      toolResult: [
        { output: "first" },
        { error: "second", attachments: [{ id: "att-1" }] },
      ],
    });

    assert.deepEqual(parts[0], {
      role: EVENT.REASONING_SIGNATURE,
      content: { signature: "sig-1" },
    });
    assert.equal(parts[1].role, EVENT.TOOL_CALL);
    assert.equal(parts[1].content.call_id, "call-1");
    assert.equal(parts[2].role, EVENT.TOOL_CALL);
    assert.equal(parts[3].role, EVENT.TOOL_RESULT);
    assert.equal(parts[3].content.result, "first");
    assert.equal(parts[4].content.result, "second");
    assert.deepEqual(parts[4].content.attachments, [{ id: "att-1" }]);
    assert.equal(JSON.stringify(parts).includes("test-key"), false);

    // feed() is kept only as an alias and returns the same shape.
    assert.deepEqual(google.feed({ reasoningSignature: "sig-1" }), parts.slice(0, 1));
  });
});
