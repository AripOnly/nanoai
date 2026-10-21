// gateway/service/settings-service.js
//
// HTTP-facing settings use-cases. Every PUT is one validated settings.update
// call (one atomic file write, one revision), even when the body changes
// several keys. Nested objects that are conceptually patches (compaction,
// provider_keys, provider_endpoints, gateway) are merged here before the
// single update.

import { ResponseError } from "../error/response-error.js";
import {
  ConfigError,
  getSnapshot,
  initSettings,
  settings,
} from "../../src/config/index.js";
import {
  isKnownProvider,
  listProviders as providerIds,
} from "../../src/llm/registry.js";
import {
  findModel as findCatalogModel,
  getCatalogSnapshot,
  getModelRegistry as getModelRegistryView,
  parseModelRef,
} from "../../src/models/index.js";
import { isGatewayTokenEnvLocked } from "../auth/token.js";

const SECRET_KEYS = ["api_key", "serper_api_key", "gateway_token"];

const ALLOWED_KEYS = [
  "username",
  "model",
  "api_key",
  "serper_api_key",
  "compaction",
  "cors_origins",
  "provider_keys",
  "provider_endpoints",
  "gateway_token",
  "gateway",
];

const PUBLIC_KEYS = [
  "username",
  "model",
  "api_key",
  "serper_api_key",
  "provider_keys",
  "provider_endpoints",
  "compaction",
  "cors_origins",
  "gateway",
];

function maskSecret(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  if (value.length <= 4) {
    return "****";
  }

  return `****${value.slice(-4)}`;
}

function toPublic(clean) {
  const result = { ...clean };

  for (const key of SECRET_KEYS) {
    if (key in result) {
      result[key] = maskSecret(result[key]);
    }
  }

  if (result.provider_keys && typeof result.provider_keys === "object") {
    const masked = {};
    for (const [provider, key] of Object.entries(result.provider_keys)) {
      masked[provider] = maskSecret(key);
    }
    result.provider_keys = masked;
  }

  return result;
}

function publicSettings(value) {
  const result = {};
  for (const key of PUBLIC_KEYS) {
    result[key] = value[key];
  }
  return toPublic(result);
}

function validateModel(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ResponseError(400, "model must be a non-empty string");
  }

  let ref;
  try {
    ref = parseModelRef(value);
  } catch {
    throw new ResponseError(
      400,
      'model must use the "provider/model" format, e.g. "google/gemini-3.6-flash"',
    );
  }

  if (!isKnownProvider(ref.provider)) {
    throw new ResponseError(
      400,
      `unknown provider "${ref.provider}". Available: ${providerIds().join(", ")}`,
    );
  }

  if (!findCatalogModel(ref.provider, ref.id)) {
    throw new ResponseError(
      400,
      `unknown model "${ref.id}" for provider "${ref.provider}".`,
    );
  }

  return value;
}

function validateSecret(value, name) {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new ResponseError(400, `${name} must be a non-empty string or null`);
  }

  return value;
}

function validateCompaction(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResponseError(400, "compaction must be an object");
  }

  const unknown = Object.keys(value).filter(
    (key) => key !== "ratio" && key !== "keep_turn",
  );
  if (unknown.length > 0) {
    throw new ResponseError(
      400,
      `compaction contains an unknown key "${unknown[0]}"`,
    );
  }

  const result = {};

  if (value.ratio !== undefined) {
    if (!Number.isInteger(value.ratio) || value.ratio < 1 || value.ratio > 100) {
      throw new ResponseError(
        400,
        "compaction.ratio must be an integer between 1 and 100",
      );
    }
    result.ratio = value.ratio;
  }

  if (value.keep_turn !== undefined) {
    if (!Number.isInteger(value.keep_turn) || value.keep_turn < 1) {
      throw new ResponseError(
        400,
        "compaction.keep_turn must be an integer >= 1",
      );
    }
    result.keep_turn = value.keep_turn;
  }

  return result;
}

function validateProviderKeys(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResponseError(400, "provider_keys must be an object");
  }

  const result = {};
  for (const [provider, key] of Object.entries(value)) {
    if (typeof provider !== "string" || provider.trim() === "") {
      throw new ResponseError(400, "provider_keys names must be non-empty");
    }
    if (key === null) {
      result[provider] = null;
      continue;
    }
    if (typeof key !== "string" || key.trim() === "") {
      throw new ResponseError(
        400,
        `provider_keys["${provider}"] must be a non-empty string or null`,
      );
    }
    result[provider] = key;
  }

  return result;
}

function validateProviderEndpoints(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResponseError(400, "provider_endpoints must be an object");
  }

  const result = {};
  for (const [provider, endpoint] of Object.entries(value)) {
    if (typeof provider !== "string" || provider.trim() === "") {
      throw new ResponseError(400, "provider_endpoints names must be non-empty");
    }
    if (endpoint === null) {
      result[provider] = null;
      continue;
    }
    if (typeof endpoint !== "string" || endpoint.trim() === "") {
      throw new ResponseError(
        400,
        `provider_endpoints["${provider}"] must be a non-empty URL or null`,
      );
    }
    try {
      const parsed = new URL(endpoint);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("bad protocol");
      }
    } catch {
      throw new ResponseError(
        400,
        `provider_endpoints["${provider}"] must be a valid http(s) URL`,
      );
    }
    result[provider] = endpoint;
  }

  return result;
}

function validateGateway(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResponseError(400, "gateway must be an object");
  }

  const unknown = Object.keys(value).filter(
    (key) => key !== "host" && key !== "port",
  );
  if (unknown.length > 0) {
    throw new ResponseError(
      400,
      `gateway contains an unknown key "${unknown[0]}"`,
    );
  }

  const result = {};
  if (value.host !== undefined) {
    if (
      value.host !== null &&
      (typeof value.host !== "string" || value.host.trim() === "")
    ) {
      throw new ResponseError(400, "gateway.host must be a non-empty string or null");
    }
    result.host = value.host;
  }
  if (value.port !== undefined) {
    if (
      value.port !== null &&
      (!Number.isInteger(value.port) ||
        value.port < 1 ||
        value.port > 65535)
    ) {
      throw new ResponseError(
        400,
        "gateway.port must be an integer between 1 and 65535 or null",
      );
    }
    result.port = value.port;
  }

  return result;
}

function validateUpdate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ResponseError(400, "request body must be an object");
  }

  const keys = Object.keys(body);

  if (keys.length === 0) {
    throw new ResponseError(400, "request body must not be empty");
  }

  for (const key of keys) {
    if (!ALLOWED_KEYS.includes(key)) {
      throw new ResponseError(
        400,
        `unknown setting "${key}". Allowed: ${ALLOWED_KEYS.join(", ")}`,
      );
    }
  }

  const validated = {};

  if (body.username !== undefined) {
    if (typeof body.username !== "string" || body.username.trim() === "") {
      throw new ResponseError(400, "username must be a non-empty string");
    }
    validated.username = body.username;
  }

  if (body.model !== undefined) {
    validated.model = validateModel(body.model);
  }

  if (body.api_key !== undefined) {
    validated.api_key = validateSecret(body.api_key, "api_key");
  }

  if (body.serper_api_key !== undefined) {
    validated.serper_api_key = validateSecret(
      body.serper_api_key,
      "serper_api_key",
    );
  }

  if (body.compaction !== undefined) {
    validated.compaction = validateCompaction(body.compaction);
  }

  if (body.cors_origins !== undefined) {
    if (
      !Array.isArray(body.cors_origins) ||
      !body.cors_origins.every(
        (origin) => typeof origin === "string" && origin.trim() !== "",
      )
    ) {
      throw new ResponseError(
        400,
        "cors_origins must be an array of non-empty strings",
      );
    }
    validated.cors_origins = body.cors_origins;
  }

  if (body.provider_keys !== undefined) {
    validated.provider_keys = validateProviderKeys(body.provider_keys);
  }

  if (body.provider_endpoints !== undefined) {
    validated.provider_endpoints = validateProviderEndpoints(
      body.provider_endpoints,
    );
  }

  if (body.gateway_token !== undefined) {
    if (isGatewayTokenEnvLocked()) {
      throw new ResponseError(
        409,
        "gateway_token is controlled by NANO_GATEWAY_TOKEN and cannot be updated while the environment override is set.",
      );
    }
    validated.gateway_token = validateSecret(
      body.gateway_token,
      "gateway_token",
    );
  }

  if (body.gateway !== undefined) {
    validated.gateway = validateGateway(body.gateway);
  }

  return validated;
}

function mergePatch(current, validated) {
  const patch = { ...validated };

  if (validated.compaction !== undefined) {
    patch.compaction = { ...current.compaction, ...validated.compaction };
  }

  if (validated.provider_keys !== undefined) {
    const merged = { ...current.provider_keys };
    for (const [provider, key] of Object.entries(validated.provider_keys)) {
      if (key === null) {
        delete merged[provider];
      } else {
        merged[provider] = key;
      }
    }
    patch.provider_keys = merged;
  }

  if (validated.provider_endpoints !== undefined) {
    const merged = { ...current.provider_endpoints };
    for (const [provider, endpoint] of Object.entries(
      validated.provider_endpoints,
    )) {
      if (endpoint === null) {
        delete merged[provider];
      } else {
        merged[provider] = endpoint;
      }
    }
    patch.provider_endpoints = merged;
  }

  if (validated.gateway !== undefined) {
    patch.gateway = { ...current.gateway, ...validated.gateway };
  }

  return patch;
}

export async function getSettings() {
  await initSettings();
  return publicSettings(getSnapshot().value);
}

export function getSettingsMeta() {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return {
      revision: null,
      restartRequired: false,
      lastError: null,
      source: null,
      updatedAt: null,
    };
  }
  return {
    revision: snapshot.revision,
    restartRequired: snapshot.restartRequired,
    lastError: snapshot.lastError,
    source: snapshot.source,
    updatedAt: snapshot.updatedAt,
  };
}

export async function updateSettingsWithMeta(body, { ifMatch, origin } = {}) {
  await initSettings();
  const current = getSnapshot();

  if (ifMatch !== undefined && ifMatch !== null && ifMatch !== "") {
    if (String(ifMatch) !== String(current.revision)) {
      throw new ResponseError(
        409,
        `settings revision changed (expected ${ifMatch}, current ${current.revision})`,
      );
    }
  }

  const validated = validateUpdate(body);

  // Do not let a browser remove the origin it is currently calling from.
  // Otherwise a successful PUT would make every following request fail CORS
  // and lock the operator out of the dashboard. File edits and CLI requests
  // (no Origin header) remain unrestricted.
  if (
    validated.cors_origins !== undefined &&
    typeof origin === "string" &&
    origin !== "" &&
    current.value.cors_origins.includes(origin) &&
    !validated.cors_origins.includes(origin)
  ) {
    throw new ResponseError(
      400,
      `refusing to remove the origin of the current request (${origin}); keep it in cors_origins or use a non-browser client`,
    );
  }

  const patch = mergePatch(current.value, validated);

  try {
    const snapshot = await settings.update(patch);
    return {
      data: publicSettings(snapshot.value),
      revision: snapshot.revision,
      restartRequired: snapshot.restartRequired,
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ResponseError(400, error.message);
    }
    throw error;
  }
}

/** Backwards-compatible shape: callers that only need the public settings. */
export async function updateSettings(body, options) {
  const result = await updateSettingsWithMeta(body, options);
  return result.data;
}

function providerEnvSuffix(provider) {
  return String(provider)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Availability is safe metadata, never the credential itself. A model whose
 * provider is not registered or has no key still appears in the catalog, but
 * the UI can show it as unavailable with a stable reason.
 */
function availabilityFor(provider) {
  if (!isKnownProvider(provider)) {
    return { available: false, unavailableReason: "provider_not_registered" };
  }

  if (process.env[`NANO_${providerEnvSuffix(provider)}_API_KEY`]) {
    return { available: true, unavailableReason: null };
  }

  const config = getSnapshot()?.value ?? {};
  const stored = config.provider_keys?.[provider];
  if (typeof stored === "string" && stored.trim() !== "") {
    return { available: true, unavailableReason: null };
  }

  if (
    provider === "google" &&
    typeof config.api_key === "string" &&
    config.api_key.trim() !== ""
  ) {
    return { available: true, unavailableReason: null };
  }

  return { available: false, unavailableReason: "credential_missing" };
}

function listProviders() {
  const registry = getModelRegistryView();
  const known = new Set(providerIds());
  for (const provider of registry.providers()) known.add(provider);

  return [...known].map((provider) => ({
    provider,
    models: registry.byProvider(provider).map((model) => ({
      id: model.id,
      name: model.name,
      context: model.contextWindow,
      status: model.status,
      capabilities: model.capabilities,
    })),
  }));
}

/** Catalog revision/error metadata for GET /api/v1/models. */
function getModelsMeta() {
  const snapshot = getCatalogSnapshot();
  return {
    revision: snapshot?.revision ?? null,
    lastError: snapshot?.lastError ?? null,
  };
}

/** Flat model view for GET /api/v1/models. */
function listModels() {
  return getModelRegistryView().models().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    wire: model.wire,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: model.capabilities,
    status: model.status,
    ...availabilityFor(model.provider),
  }));
}

export default {
  getSettings,
  getSettingsMeta,
  updateSettings,
  updateSettingsWithMeta,
  listProviders,
  listModels,
  getModelsMeta,
};
