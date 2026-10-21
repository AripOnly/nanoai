// test/suite/provider-config.test.js
//
// Provider credential/endpoint precedence. Environment wins, then the
// per-provider setting, and the legacy top-level api_key remains Google-only.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  credentialsFor,
  endpointFor,
  providerEnvKey,
} from "../../src/runtime/index.js";

const PROVIDERS = Object.freeze([
  "google",
  "openai",
  "anthropic",
  "openrouter",
  "opencode-zen",
]);

const ENV_SUFFIX = Object.freeze({
  google: "GOOGLE",
  openai: "OPENAI",
  anthropic: "ANTHROPIC",
  openrouter: "OPENROUTER",
  "opencode-zen": "OPENCODE_ZEN",
});

describe("provider credential precedence", () => {
  it("uses NANO_<PROVIDER>_API_KEY first", () => {
    for (const provider of PROVIDERS) {
      const env = {
        [`NANO_${ENV_SUFFIX[provider]}_API_KEY`]: `  env-${provider}  `,
      };
      const config = {
        provider_keys: { [provider]: "stored-key" },
        api_key: "legacy-key",
      };
      assert.equal(providerEnvKey(provider), ENV_SUFFIX[provider]);
      assert.deepEqual(credentialsFor(provider, config, env), {
        apiKey: `env-${provider}`,
      });
    }
  });

  it("falls back to provider_keys for every provider", () => {
    for (const provider of PROVIDERS) {
      const config = {
        provider_keys: { [provider]: "  stored-key  " },
      };
      assert.deepEqual(credentialsFor(provider, config, {}), {
        apiKey: "stored-key",
      });
    }
  });

  it("uses the legacy api_key only for Google", () => {
    const config = { api_key: "legacy-key" };
    assert.deepEqual(credentialsFor("google", config, {}), {
      apiKey: "legacy-key",
    });
    for (const provider of PROVIDERS.filter((id) => id !== "google")) {
      assert.equal(credentialsFor(provider, config, {}), null);
    }
  });

  it("returns null for missing and blank credentials", () => {
    assert.equal(credentialsFor("openai", {}, {}), null);
    assert.equal(
      credentialsFor("openai", { provider_keys: { openai: "   " } }, {}),
      null,
    );
  });
});

describe("provider endpoint precedence", () => {
  it("uses NANO_<PROVIDER>_BASE_URL first", () => {
    for (const provider of PROVIDERS) {
      const env = {
        [`NANO_${ENV_SUFFIX[provider]}_BASE_URL`]:
          `https://env-${provider}.test/v1`,
      };
      const config = {
        provider_endpoints: {
          [provider]: `https://stored-${provider}.test/v1`,
        },
      };
      assert.equal(
        endpointFor(provider, config, env),
        `https://env-${provider}.test/v1`,
      );
    }
  });

  it("falls back to provider_endpoints, otherwise leaves the adapter default", () => {
    for (const provider of PROVIDERS) {
      const config = {
        provider_endpoints: {
          [provider]: `  https://stored-${provider}.test/v1  `,
        },
      };
      assert.equal(
        endpointFor(provider, config, {}),
        `https://stored-${provider}.test/v1`,
      );
      assert.equal(endpointFor(provider, {}, {}), null);
    }
  });
});
