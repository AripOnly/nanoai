// test/contracts/provider-selection.test.js
//
// The shipped catalog and real provider registry must resolve every advertised
// provider through the same contract. This file configures real adapters with
// throwaway keys but never performs a network call.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadCatalogSync, validateCatalog } from "../../src/models/catalog.js";
import { createModelRegistry } from "../../src/models/registry.js";
import {
  ModelResolveError,
  RESOLVE_ERROR_CODES as CODES,
  resolveModel,
} from "../../src/models/resolver.js";
import { getProvider, getProviderRegistry } from "../../src/llm/registry.js";

const CATALOG_PATH = fileURLToPath(
  new URL("../../config/models.json", import.meta.url),
);

const shipped = validateCatalog(loadCatalogSync(CATALOG_PATH));
const registry = createModelRegistry({ ...shipped, revision: 1 });
const providers = getProviderRegistry();

const SELECTIONS = Object.freeze([
  {
    ref: "google/gemini-3.1-flash-lite",
    provider: "google",
    id: "gemini-3.1-flash-lite",
    wire: "google-interactions",
  },
  {
    ref: "openai/gpt-5.5",
    provider: "openai",
    id: "gpt-5.5",
    wire: "openai-responses",
  },
  {
    ref: "anthropic/claude-sonnet-5-5",
    provider: "anthropic",
    id: "claude-sonnet-5-5",
    wire: "anthropic-messages",
  },
  {
    ref: "openrouter/deepseek/deepseek-v4.1-flash",
    provider: "openrouter",
    id: "deepseek/deepseek-v4.1-flash",
    wire: "openai-chat",
  },
  {
    ref: "opencode-zen/gpt-5.5",
    provider: "opencode-zen",
    id: "gpt-5.5",
    wire: "openai-responses",
  },
  {
    ref: "opencode-zen/deepseek-v4.1-flash",
    provider: "opencode-zen",
    id: "deepseek-v4.1-flash",
    wire: "openai-chat",
  },
]);

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ModelResolveError, error?.stack);
    return error.code;
  }
  assert.fail("expected ModelResolveError");
}

describe("shipped provider selection", () => {
  it("covers all five providers and the default model", () => {
    assert.deepEqual(
      [...new Set(shipped.models.map((model) => model.provider))].sort(),
      ["anthropic", "google", "openai", "opencode-zen", "openrouter"],
    );
    assert.ok(registry.find("google", "gemini-3.1-flash-lite"));
    assert.ok(registry.find("openrouter", "deepseek/deepseek-v4.1-flash"));
  });

  it("resolves every advertised provider/model through one contract", () => {
    for (const selection of SELECTIONS) {
      const handle = resolveModel({
        modelRef: selection.ref,
        registry,
        providers,
        credentials: { apiKey: "throwaway-test-key" },
      });

      assert.equal(handle.providerId, selection.provider);
      assert.equal(handle.modelId, selection.id);
      assert.equal(handle.modelRef, selection.ref);
      assert.equal(handle.wire, selection.wire);
      assert.equal(handle.adapter, getProvider(selection.provider));
      assert.equal(
        JSON.stringify({ ...handle, adapter: null }).includes(
          "throwaway-test-key",
        ),
        false,
      );
    }
  });

  it("reports a missing key for every provider without fallback", () => {
    for (const selection of SELECTIONS) {
      assert.equal(
        codeOf(() =>
          resolveModel({
            modelRef: selection.ref,
            registry,
            providers,
          }),
        ),
        CODES.CREDENTIAL_MISSING,
      );
    }
  });

  it("rejects native Anthropic and Google wires on OpenCode Zen", () => {
    const native = validateCatalog({
      schemaVersion: 2,
      models: [
        {
          provider: "opencode-zen",
          id: "native-anthropic",
          name: "Native Anthropic",
          wire: "anthropic-messages",
          contextWindow: 1000,
          maxOutputTokens: 100,
          capabilities: { streaming: true },
          status: "active",
        },
        {
          provider: "opencode-zen",
          id: "native-google",
          name: "Native Google",
          wire: "google-interactions",
          contextWindow: 1000,
          maxOutputTokens: 100,
          capabilities: { streaming: true },
          status: "active",
        },
      ],
    });
    const nativeRegistry = createModelRegistry({ ...native, revision: 1 });

    for (const id of ["native-anthropic", "native-google"]) {
      assert.equal(
        codeOf(() =>
          resolveModel({
            modelRef: `opencode-zen/${id}`,
            registry: nativeRegistry,
            providers,
            credentials: { apiKey: "throwaway-test-key" },
          }),
        ),
        CODES.WIRE_UNSUPPORTED,
      );
    }
  });
});
