// test/suite/registry.test.js
// Offline. Locks the LLM provider registry — the one window agents and doors
// use to reach providers. No network calls; provider implementations are
// stubs here, the real google implementation is only inspected structurally.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findModel,
  getProvider,
  isKnownModel,
  isKnownProvider,
  listProviders,
  registerProvider,
} from "../../src/llm/registry.js";

describe("llm registry", () => {
  it("registers google with a validated model catalog", () => {
    assert.deepEqual(listProviders(), ["google"]);
    const entry = getProvider("google");
    assert.equal(typeof entry.request, "function");
    assert.equal(typeof entry.feed, "function");
    assert.ok(entry.models.length > 0, "expected at least one catalog model");
    for (const model of entry.models) {
      assert.ok(typeof model.id === "string" && model.id.length > 0);
      assert.ok(Number.isInteger(model.context) && model.context > 0);
    }
  });

  it("answers membership through isKnownProvider / isKnownModel / findModel", () => {
    assert.equal(isKnownProvider("google"), true);
    assert.equal(isKnownProvider("nope"), false);
    assert.equal(isKnownModel("google", "gemini-3.1-flash-lite"), true);
    assert.equal(isKnownModel("google", "nope"), false);
    assert.equal(findModel("google", "nope"), undefined);
    assert.equal(findModel("nope", "gemini-3.1-flash-lite"), undefined);
  });

  it("throws a clear error for unknown providers, listing the known ones", () => {
    assert.throws(
      () => getProvider("nope"),
      /Unknown provider: nope\. Available providers: google\./,
    );
  });

  it("rejects malformed provider implementations at registration", () => {
    assert.throws(
      () => registerProvider("", { request() {}, feed() {} }),
      /non-empty string/,
    );
    assert.throws(
      () => registerProvider("broken", { feed() {} }),
      /must export request\(\)/,
    );
    assert.throws(
      () => registerProvider("broken", { request() {} }),
      /must export feed\(\)/,
    );
  });

  it("keeps the legacy llm table in sync through the llm.js wrapper", async () => {
    const { llm } = await import("../../src/llm/llm.js");
    assert.equal(llm.google, getProvider("google"));
  });
});
