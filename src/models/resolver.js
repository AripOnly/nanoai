// src/models/resolver.js
//
// Pure model resolution, in the plan's order:
//   Agent Core → Model Resolver → Model Registry → Provider Adapter → SDK
//
// The resolver never performs a network call and never silently falls back to
// another model or provider: every failure is an explicit ModelResolveError
// with a stable code. It receives the provider registry and the credential /
// endpoint values as plain inputs, so it has no import edge to settings, env,
// or any SDK.
//
// The returned handle is safe to pass into agent code: it carries the model
// metadata, the configured adapter, and limits, but never the credential.

import { parseModelRef, ModelRefError } from "./ref.js";

export const RESOLVE_ERROR_CODES = Object.freeze({
  REF_INVALID: "MODEL_REF_INVALID",
  PROVIDER_UNKNOWN: "PROVIDER_UNKNOWN",
  MODEL_UNKNOWN: "MODEL_UNKNOWN",
  MODEL_DISABLED: "MODEL_DISABLED",
  MODEL_DEPRECATED: "MODEL_DEPRECATED",
  WIRE_UNSUPPORTED: "WIRE_UNSUPPORTED",
  CREDENTIAL_MISSING: "CREDENTIAL_MISSING",
  ENDPOINT_INVALID: "ENDPOINT_INVALID",
  CAPABILITY_UNSUPPORTED: "CAPABILITY_UNSUPPORTED",
  CONTEXT_TOO_SMALL: "CONTEXT_TOO_SMALL",
  CONFIGURE_FAILED: "PROVIDER_CONFIGURE_FAILED",
});

export class ModelResolveError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ModelResolveError";
    this.code = code;
    this.provider = details.provider ?? null;
    this.model = details.model ?? null;
    this.capability = details.capability ?? null;
  }
}

function fail(code, message, details) {
  throw new ModelResolveError(code, message, details);
}

function providerFrom(providers, id) {
  if (!providers) return undefined;
  try {
    if (typeof providers.has === "function" && !providers.has(id)) {
      return undefined;
    }
    if (typeof providers.get === "function") return providers.get(id);
    if (Object.hasOwn(providers, id)) return providers[id];
    return undefined;
  } catch {
    // A throwing registry is treated as "provider unavailable"; the resolver
    // owns the user-facing taxonomy, not the registry.
    return undefined;
  }
}

function capabilityNames(requiredCapabilities) {
  if (requiredCapabilities == null) return [];
  if (Array.isArray(requiredCapabilities)) {
    return requiredCapabilities.filter(
      (name) => typeof name === "string" && name.trim() !== "",
    );
  }
  if (typeof requiredCapabilities === "object") {
    return Object.entries(requiredCapabilities)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name);
  }
  return [];
}

function credentialKey(credentials) {
  if (typeof credentials === "string") return credentials.trim();
  if (credentials && typeof credentials === "object") {
    const value = credentials.apiKey ?? credentials.api_key;
    return typeof value === "string" ? value.trim() : "";
  }
  return "";
}

function validateEndpoint(endpoint) {
  if (endpoint === undefined || endpoint === null || endpoint === "") {
    return null;
  }
  if (typeof endpoint !== "string") {
    fail(
      RESOLVE_ERROR_CODES.ENDPOINT_INVALID,
      "Provider endpoint must be an http(s) URL.",
    );
  }
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    fail(
      RESOLVE_ERROR_CODES.ENDPOINT_INVALID,
      "Provider endpoint must be a valid http(s) URL.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(
      RESOLVE_ERROR_CODES.ENDPOINT_INVALID,
      "Provider endpoint must use http or https.",
    );
  }
  return endpoint;
}

/**
 * Resolve one model reference.
 *
 * @param {object} input
 * @param {string} input.modelRef                 "provider/model"
 * @param {object} input.registry                 createModelRegistry() result
 * @param {object} input.providers                provider registry ({ get } or object map)
 * @param {string|object} [input.credentials]     API key (string or { apiKey })
 * @param {string|null} [input.endpoint]          optional custom base URL
 * @param {string[]} [input.requiredCapabilities] capability names that must be true
 * @param {number|null} [input.contextBudget]     minimum required context window
 * @param {boolean} [input.allowDeprecated]
 * @returns {Readonly<object>} frozen handle without credentials
 */
export function resolveModel({
  modelRef,
  registry,
  providers,
  credentials = null,
  endpoint = null,
  requiredCapabilities = [],
  contextBudget = null,
  allowDeprecated = false,
} = {}) {
  let ref;
  try {
    ref = parseModelRef(modelRef);
  } catch (error) {
    if (error instanceof ModelRefError) {
      fail(RESOLVE_ERROR_CODES.REF_INVALID, error.message);
    }
    throw error;
  }

  const adapter = providerFrom(providers, ref.provider);
  if (!adapter) {
    fail(
      RESOLVE_ERROR_CODES.PROVIDER_UNKNOWN,
      `Unknown provider "${ref.provider}".`,
      { provider: ref.provider, model: ref.id },
    );
  }

  if (!registry || typeof registry.find !== "function") {
    fail(
      RESOLVE_ERROR_CODES.MODEL_UNKNOWN,
      "Model registry is not available.",
      { provider: ref.provider, model: ref.id },
    );
  }

  const model = registry.find(ref.provider, ref.id);
  if (!model) {
    fail(
      RESOLVE_ERROR_CODES.MODEL_UNKNOWN,
      `Unknown model "${ref.id}" for provider "${ref.provider}".`,
      { provider: ref.provider, model: ref.id },
    );
  }

  if (model.status === "disabled") {
    fail(
      RESOLVE_ERROR_CODES.MODEL_DISABLED,
      `Model "${ref.ref}" is disabled.`,
      { provider: ref.provider, model: ref.id },
    );
  }

  if (model.status === "deprecated" && !allowDeprecated) {
    fail(
      RESOLVE_ERROR_CODES.MODEL_DEPRECATED,
      `Model "${ref.ref}" is deprecated. Enable it explicitly to continue.`,
      { provider: ref.provider, model: ref.id },
    );
  }

  const supportedWires = Array.isArray(adapter.supportedWires)
    ? adapter.supportedWires
    : [];
  if (!supportedWires.includes(model.wire)) {
    fail(
      RESOLVE_ERROR_CODES.WIRE_UNSUPPORTED,
      `Provider "${ref.provider}" does not support wire "${model.wire}" for model "${ref.id}".`,
      { provider: ref.provider, model: ref.id },
    );
  }

  const apiKey = credentialKey(credentials);
  if (apiKey === "") {
    fail(
      RESOLVE_ERROR_CODES.CREDENTIAL_MISSING,
      `No API key configured for provider "${ref.provider}".`,
      { provider: ref.provider, model: ref.id },
    );
  }

  const resolvedEndpoint = validateEndpoint(endpoint);

  for (const capability of capabilityNames(requiredCapabilities)) {
    if (model.capabilities?.[capability] !== true) {
      fail(
        RESOLVE_ERROR_CODES.CAPABILITY_UNSUPPORTED,
        `Model "${ref.ref}" does not support capability "${capability}".`,
        { provider: ref.provider, model: ref.id, capability },
      );
    }
  }

  if (contextBudget !== null && contextBudget !== undefined) {
    if (!Number.isInteger(contextBudget) || contextBudget <= 0) {
      fail(
        RESOLVE_ERROR_CODES.CONTEXT_TOO_SMALL,
        "Context budget must be a positive integer.",
        { provider: ref.provider, model: ref.id },
      );
    }
    if (contextBudget > model.contextWindow) {
      fail(
        RESOLVE_ERROR_CODES.CONTEXT_TOO_SMALL,
        `Model "${ref.ref}" has a ${model.contextWindow} token context window, less than the requested ${contextBudget}.`,
        { provider: ref.provider, model: ref.id },
      );
    }
  }

  try {
    adapter.configure({ credentials: { apiKey }, endpoint: resolvedEndpoint });
  } catch (error) {
    fail(
      RESOLVE_ERROR_CODES.CONFIGURE_FAILED,
      `Provider "${ref.provider}" could not be configured.`,
      { provider: ref.provider, model: ref.id },
    );
  }

  return Object.freeze({
    providerId: ref.provider,
    modelId: ref.id,
    modelRef: ref.ref,
    model,
    adapter,
    wire: model.wire,
    limits: Object.freeze({
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
    }),
    capabilities: model.capabilities,
  });
}

/** Bind catalog/registry/provider inputs once; resolve per turn. */
export function createModelResolver({ registry, providers } = {}) {
  return Object.freeze({
    resolve(input = {}) {
      return resolveModel({ registry, providers, ...input });
    },
  });
}
