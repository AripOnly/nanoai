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
  it("registers google as a configured one-client adapter", () => {
    assert.deepEqual(listProviders(), ["google"]);
    const entry = getProvider("google");
    assert.equal(entry.id, "google");
    assert.equal(typeof entry.configure, "function");
    assert.equal(typeof entry.request, "function");
    assert.equal(typeof entry.continue, "function");
    assert.equal(typeof entry.dispose, "function");
    assert.deepEqual(entry.supportedWires, ["google-interactions"]);
    assert.equal(entry.models, undefined, "providers must not own a catalog");
  });

  it("answers provider membership without knowing models", () => {
    assert.equal(isKnownProvider("google"), true);
    assert.equal(isKnownProvider("nope"), false);
  });

  it("throws a clear error for unknown providers, listing the known ones", () => {
    assert.throws(
      () => getProvider("nope"),
      /Unknown provider: nope\. Available providers: google\./,
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
    assert.equal(llm.google, getProvider("google"));
  });
});
