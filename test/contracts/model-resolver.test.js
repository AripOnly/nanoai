// test/contracts/model-resolver.test.js
//
// Resolver contract: explicit provider/model selection, plan-order validation,
// stable error taxonomy, and a frozen handle that never carries a credential.
// The providers here are in-memory stubs; no SDK and no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createModelRegistry } from "../../src/models/registry.js";
import { validateCatalog } from "../../src/models/catalog.js";
import {
  ModelResolveError,
  RESOLVE_ERROR_CODES as CODES,
  createModelResolver,
  resolveModel,
} from "../../src/models/resolver.js";

function model(overrides = {}) {
  return {
    provider: "google",
    id: "gemini-test",
    name: "Gemini Test",
    wire: "google-wire",
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    capabilities: {
      streaming: true,
      toolCalling: true,
      vision: true,
    },
    status: "active",
    ...overrides,
  };
}

const snapshot = {
  revision: 3,
  ...validateCatalog({
    schemaVersion: 2,
    models: [
      model(),
      model({ id: "gemini-disabled", status: "disabled" }),
      model({ id: "gemini-old", status: "deprecated" }),
      model({ id: "gemini-other-wire", wire: "other-wire" }),
      model({ provider: "openrouter", id: "deepseek/deepseek-chat", wire: "openrouter-wire" }),
    ],
  }),
};
const registry = createModelRegistry(snapshot);

function stubProvider(id, { wires = ["google-wire"], configureError = null } = {}) {
  const calls = [];
  return {
    id,
    supportedWires: wires,
    calls,
    configure(input) {
      calls.push(input);
      if (configureError) throw configureError;
      return this;
    },
    request: async function* request() {},
    continue() {
      return [];
    },
    dispose() {},
  };
}

function providersWith(...adapters) {
  return new Map(adapters.map((adapter) => [adapter.id, adapter]));
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ModelResolveError, error?.stack);
    return error.code;
  }
  assert.fail("expected ModelResolveError");
}

const baseInput = {
  registry,
  credentials: { apiKey: "test-key" },
};

describe("model resolver success path", () => {
  it("returns a frozen, credential-free handle and configures the adapter once", () => {
    const google = stubProvider("google");
    const handle = resolveModel({
      ...baseInput,
      modelRef: "google/gemini-test",
      providers: providersWith(google),
      endpoint: "https://example.test/v1",
    });

    assert.equal(handle.providerId, "google");
    assert.equal(handle.modelId, "gemini-test");
    assert.equal(handle.modelRef, "google/gemini-test");
    assert.equal(handle.wire, "google-wire");
    assert.equal(handle.limits.contextWindow, 1_000_000);
    assert.equal(handle.limits.maxOutputTokens, 8_192);
    assert.equal(handle.capabilities.vision, true);
    assert.equal(handle.adapter, google);
    assert.ok(Object.isFrozen(handle));
    assert.ok(Object.isFrozen(handle.limits));

    assert.deepEqual(google.calls, [
      {
        credentials: { apiKey: "test-key" },
        endpoint: "https://example.test/v1",
      },
    ]);
    // The resolver itself never adds the credential to the handle. (The stub
    // adapter records its configure input for the assertion above; real
    // adapters keep it inside the SDK client.)
    assert.equal("credentials" in handle, false);
    assert.equal(
      JSON.stringify({ ...handle, adapter: null }).includes("test-key"),
      false,
    );
  });

  it("keeps nested ids intact for OpenRouter", () => {
    const openrouter = stubProvider("openrouter", { wires: ["openrouter-wire"] });
    const handle = resolveModel({
      ...baseInput,
      modelRef: "openrouter/deepseek/deepseek-chat",
      providers: providersWith(openrouter),
    });

    assert.equal(handle.modelId, "deepseek/deepseek-chat");
    assert.equal(handle.adapter, openrouter);
  });

  it("accepts capabilities as an array or a { name: true } object", () => {
    const google = stubProvider("google");
    const args = {
      ...baseInput,
      modelRef: "google/gemini-test",
      providers: providersWith(google),
    };

    assert.equal(resolveModel({ ...args, requiredCapabilities: ["vision"] }).modelId, "gemini-test");
    assert.equal(
      resolveModel({
        ...args,
        requiredCapabilities: { toolCalling: true, vision: false },
      }).modelId,
      "gemini-test",
    );
  });

  it("allows a deprecated model only when explicitly requested", () => {
    const google = stubProvider("google");
    const args = {
      ...baseInput,
      modelRef: "google/gemini-old",
      providers: providersWith(google),
    };

    assert.equal(codeOf(() => resolveModel(args)), CODES.MODEL_DEPRECATED);
    assert.equal(
      resolveModel({ ...args, allowDeprecated: true }).modelId,
      "gemini-old",
    );
  });
});

describe("model resolver error taxonomy", () => {
  const google = stubProvider("google");
  const providers = providersWith(google);

  it("reports malformed refs first", () => {
    for (const modelRef of [null, "", "google", "/gemini"]) {
      assert.equal(
        codeOf(() => resolveModel({ ...baseInput, modelRef, providers })),
        CODES.REF_INVALID,
      );
    }
  });

  it("checks the provider before the catalog entry", () => {
    assert.equal(
      codeOf(() =>
        resolveModel({
          ...baseInput,
          modelRef: "nope/not-in-catalog",
          providers,
        }),
      ),
      CODES.PROVIDER_UNKNOWN,
    );
  });

  it("reports unknown, disabled, and unsupported-wire models", () => {
    assert.equal(
      codeOf(() =>
        resolveModel({ ...baseInput, modelRef: "google/missing", providers }),
      ),
      CODES.MODEL_UNKNOWN,
    );
    assert.equal(
      codeOf(() =>
        resolveModel({ ...baseInput, modelRef: "google/gemini-disabled", providers }),
      ),
      CODES.MODEL_DISABLED,
    );
    assert.equal(
      codeOf(() =>
        resolveModel({
          ...baseInput,
          modelRef: "google/gemini-other-wire",
          providers,
        }),
      ),
      CODES.WIRE_UNSUPPORTED,
    );
  });

  it("requires a credential and a valid endpoint", () => {
    assert.equal(
      codeOf(() =>
        resolveModel({
          registry,
          modelRef: "google/gemini-test",
          providers,
        }),
      ),
      CODES.CREDENTIAL_MISSING,
    );
    assert.equal(
      codeOf(() =>
        resolveModel({
          ...baseInput,
          credentials: { apiKey: "   " },
          modelRef: "google/gemini-test",
          providers,
        }),
      ),
      CODES.CREDENTIAL_MISSING,
    );

    for (const endpoint of ["not a url", "ftp://example.test", 42]) {
      assert.equal(
        codeOf(() =>
          resolveModel({
            ...baseInput,
            modelRef: "google/gemini-test",
            providers,
            endpoint,
          }),
        ),
        CODES.ENDPOINT_INVALID,
      );
    }
  });

  it("rejects unsupported capabilities and a too-small context budget", () => {
    const googleAdapter = stubProvider("google");
    const localProviders = providersWith(googleAdapter);
    const args = {
      ...baseInput,
      modelRef: "google/gemini-test",
      providers: localProviders,
    };

    assert.equal(
      codeOf(() =>
        resolveModel({ ...args, requiredCapabilities: ["audio"] }),
      ),
      CODES.CAPABILITY_UNSUPPORTED,
    );
    assert.equal(
      codeOf(() =>
        resolveModel({ ...args, requiredCapabilities: { audio: true } }),
      ),
      CODES.CAPABILITY_UNSUPPORTED,
    );
    assert.equal(
      codeOf(() => resolveModel({ ...args, contextBudget: 2_000_000 })),
      CODES.CONTEXT_TOO_SMALL,
    );
    assert.equal(
      codeOf(() => resolveModel({ ...args, contextBudget: 0 })),
      CODES.CONTEXT_TOO_SMALL,
    );
  });

  it("wraps configure failures without leaking the underlying message", () => {
    const broken = stubProvider("google", {
      configureError: new Error("bad key sk-super-secret"),
    });
    let caught;
    try {
      resolveModel({
        ...baseInput,
        modelRef: "google/gemini-test",
        providers: providersWith(broken),
      });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof ModelResolveError);
    assert.equal(caught.code, CODES.CONFIGURE_FAILED);
    assert.equal(caught.message.includes("sk-super-secret"), false);
  });

  it("treats a throwing provider registry as provider unavailable", () => {
    assert.equal(
      codeOf(() =>
        resolveModel({
          ...baseInput,
          modelRef: "google/gemini-test",
          providers: {
            has() {
              throw new Error("registry exploded");
            },
          },
        }),
      ),
      CODES.PROVIDER_UNKNOWN,
    );
  });
});

describe("bound resolver", () => {
  it("resolves against the registry/providers bound at construction", () => {
    const google = stubProvider("google");
    const resolver = createModelResolver({
      registry,
      providers: providersWith(google),
    });

    const handle = resolver.resolve({
      modelRef: "google/gemini-test",
      credentials: "test-key",
    });
    assert.equal(handle.modelId, "gemini-test");
    assert.deepEqual(google.calls[0].credentials, { apiKey: "test-key" });
  });
});
