// test/suite/registry.test.js
// Offline. Locks the provider-only LLM registry. Model metadata lives in
// src/models/ now and has its own suite; providers must not expose models.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getProvider,
  isKnownProvider,
  listProviders,
  registerProvider,
} from "../../src/llm/registry.js";

const PROVIDERS = Object.freeze({
  google: ["google-interactions"],
  openai: ["openai-responses", "openai-chat"],
  anthropic: ["anthropic-messages"],
  openrouter: ["openai-responses", "openai-chat"],
  "opencode-zen": ["openai-responses", "openai-chat"],
});

function validProvider(id, overrides = {}) {
  return {
    id,
    supportedWires: ["test-wire"],
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

describe("llm provider registry", () => {
  it("registers all five adapters as configured one-client providers", () => {
    assert.deepEqual(listProviders(), Object.keys(PROVIDERS));

    for (const [id, wires] of Object.entries(PROVIDERS)) {
      const entry = getProvider(id);
      assert.equal(entry.id, id);
      assert.equal(typeof entry.configure, "function");
      assert.equal(typeof entry.request, "function");
      assert.equal(typeof entry.continue, "function");
      assert.equal(typeof entry.dispose, "function");
      assert.deepEqual(entry.supportedWires, wires);
      assert.equal(entry.models, undefined, "providers must not own a catalog");
    }
  });

  it("answers provider membership without knowing models", () => {
    for (const id of Object.keys(PROVIDERS)) {
      assert.equal(isKnownProvider(id), true);
    }
    assert.equal(isKnownProvider("nope"), false);
    assert.equal(isKnownProvider(null), false);
    assert.equal(isKnownProvider("toString"), false);
  });

  it("throws a clear error for unknown providers, listing the known ones", () => {
    assert.throws(
      () => getProvider("nope"),
      new RegExp(
        `Unknown provider: nope\\. Available providers: ${Object.keys(PROVIDERS).join(", ")}\\.`,
      ),
    );
  });

  it("rejects malformed provider implementations at registration", () => {
    assert.throws(
      () =>
        registerProvider("", {
          request() {},
          continue() {
            return [];
          },
        }),
      /non-empty string/,
    );
    assert.throws(
      () => registerProvider("broken", validProvider("broken", { request: undefined })),
      /must export request\(\)/,
    );
    assert.throws(
      () =>
        registerProvider(
          "broken",
          validProvider("broken", { continue: undefined, feed: undefined }),
        ),
      /must export continue\(\)/,
    );
    assert.throws(
      () => registerProvider("broken", validProvider("broken", { dispose: undefined })),
      /must export dispose\(\)/,
    );
    assert.throws(
      () => registerProvider("broken", validProvider("broken", { id: "other" })),
      /matching id/,
    );
    assert.throws(
      () => registerProvider("broken", validProvider("broken", { supportedWires: [] })),
      /supportedWires/,
    );
  });

  it("keeps the legacy llm table in sync through the llm.js wrapper", async () => {
    const { llm } = await import("../../src/llm/llm.js");
    for (const id of Object.keys(PROVIDERS)) {
      assert.equal(llm[id], getProvider(id));
    }
  });
});
