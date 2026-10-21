// src/runtime/index.js
//
// Runtime composition. The gateway boots this once with the provider registry,
// the model catalog snapshot, the settings snapshot, and the session door;
// runTurn() then owns the whole turn lifecycle. Nothing in this module reads
// global settings at call time: the snapshot is captured per turn by runTurn.

import * as sessionDoor from "#src/session/index.js";
import { getProviderRegistry } from "#src/llm/registry.js";
import {
  createModelRegistry,
  getCatalogSnapshot,
  parseModelRef,
  resolveModel,
} from "#src/models/index.js";
import { getSnapshot } from "#src/config/index.js";
import { runTurn } from "./turn.js";

export { runTurn } from "./turn.js";
export {
  compactConversation,
  prunedInputAfterCompaction,
  shouldCompact,
} from "./compaction.js";

/** "opencode-zen" -> "OPENCODE_ZEN" for NANO_<PROVIDER>_API_KEY. */
export function providerEnvKey(provider) {
  return String(provider)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Credential precedence: environment, then the per-provider key, then the
 * legacy top-level api_key for google. Never written to logs or snapshots.
 */
export function credentialsFor(provider, config = {}, env = process.env) {
  const fromEnv = env[`NANO_${providerEnvKey(provider)}_API_KEY`];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return { apiKey: fromEnv.trim() };
  }

  const stored = config?.provider_keys?.[provider];
  if (typeof stored === "string" && stored.trim() !== "") {
    return { apiKey: stored.trim() };
  }

  if (provider === "google") {
    const legacy = config?.api_key;
    if (typeof legacy === "string" && legacy.trim() !== "") {
      return { apiKey: legacy.trim() };
    }
  }

  return null;
}

/** Endpoint precedence: environment, then provider_endpoints, else default. */
export function endpointFor(provider, config = {}, env = process.env) {
  const fromEnv = env[`NANO_${providerEnvKey(provider)}_BASE_URL`];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }

  const stored = config?.provider_endpoints?.[provider];
  if (typeof stored === "string" && stored.trim() !== "") {
    return stored.trim();
  }

  return null;
}

/**
 * Build the runtime used by the gateway.
 *
 * @param {object} [options]
 * @param {object} [options.session]    session door (injected in tests)
 * @param {object} [options.providers]  provider registry view
 * @param {Function} [options.catalog]  () => catalog snapshot
 * @param {Function} [options.config]   () => settings snapshot ({ value })
 * @param {object} [options.env]
 * @param {object} [options.logger]
 */
export function createRuntime({
  session = sessionDoor,
  providers = getProviderRegistry(),
  catalog = getCatalogSnapshot,
  config = getSnapshot,
  env = process.env,
  logger = console,
} = {}) {
  async function resolveTurnModel({
    modelRef,
    requiredCapabilities = [],
    config: turnConfig = {},
    catalog: turnCatalog,
  }) {
    const snapshot = turnCatalog ?? catalog();
    const registry = createModelRegistry(snapshot);
    const ref = parseModelRef(modelRef);

    return resolveModel({
      modelRef,
      registry,
      providers,
      credentials: credentialsFor(ref.provider, turnConfig, env),
      endpoint: endpointFor(ref.provider, turnConfig, env),
      requiredCapabilities,
    });
  }

  return Object.freeze({
    runTurn(input) {
      return runTurn({
        ...input,
        deps: {
          session,
          getConfig: () => config()?.value ?? {},
          getCatalog: () => catalog(),
          resolveModel: resolveTurnModel,
          logger,
        },
      });
    },

    /** Release provider clients on gateway shutdown. */
    dispose() {
      const ids =
        typeof providers.list === "function"
          ? providers.list()
          : Object.keys(providers ?? {});
      for (const id of ids) {
        try {
          const provider =
            typeof providers.get === "function"
              ? providers.get(id)
              : providers[id];
          provider?.dispose?.();
        } catch {
          // Shutdown must continue even if one adapter fails to dispose.
        }
      }
    },
  });
}
