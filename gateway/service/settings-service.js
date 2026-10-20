// gateway/service/settings-service.js

import { ResponseError } from "../error/response-error.js";
import { settings } from "../../src/config/config.js";
import {
  getProvider,
  isKnownModel,
  isKnownProvider,
  listProviders as providerIds,
} from "../../src/llm/registry.js";
import { setOrigins } from "../auth/origins.js";

const SECRET_KEYS = ["api_key", "serper_api_key"];

const ALLOWED_KEYS = [
  "username",
  "model",
  "api_key",
  "serper_api_key",
  "compaction",
  "cors_origins",
  "provider_keys",
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

function validateModel(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ResponseError(400, "model must be a non-empty string");
  }

  const [provider, model] = value.split("/");

  if (!provider || !model || value.split("/").length !== 2) {
    throw new ResponseError(
      400,
      'model must use the "provider/model" format, e.g. "google/gemini-3.6-flash"',
    );
  }

  if (!isKnownProvider(provider)) {
    throw new ResponseError(
      400,
      `unknown provider "${provider}". Available: ${providerIds().join(", ")}`,
    );
  }

  if (!isKnownModel(provider, model)) {
    throw new ResponseError(
      400,
      `unknown model "${model}" for provider "${provider}".`,
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

  return validated;
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

async function getSettings() {
  const current = await settings.get([
    "username",
    "model",
    "api_key",
    "serper_api_key",
    "compaction",
  ]);

  let corsOrigins = [];
  try {
    const stored = await settings.get("cors_origins");
    if (Array.isArray(stored)) {
      corsOrigins = stored;
    }
  } catch {
    corsOrigins = [];
  }

  let providerKeys = {};
  try {
    const stored = await settings.get("provider_keys");
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      providerKeys = stored;
    }
  } catch {
    providerKeys = {};
  }

  return toPublic({ ...current, cors_origins: corsOrigins, provider_keys: providerKeys });
}

async function updateSettings(body) {
  const validated = validateUpdate(body);

  if (validated.compaction !== undefined) {
    const current = await settings.get("compaction");
    await settings.set("compaction", { ...current, ...validated.compaction });
  }

  if (validated.cors_origins !== undefined) {
    await settings.set("cors_origins", validated.cors_origins);
    setOrigins(validated.cors_origins);
  }

  if (validated.provider_keys !== undefined) {
    let current = {};
    try {
      const stored = await settings.get("provider_keys");
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        current = stored;
      }
    } catch {
      current = {};
    }
    const merged = { ...current };
    for (const [provider, key] of Object.entries(validated.provider_keys)) {
      if (key === null) {
        delete merged[provider];
      } else {
        merged[provider] = key;
      }
    }
    await settings.set("provider_keys", merged);
  }

  for (const [key, value] of Object.entries(validated)) {
    if (key === "compaction" || key === "cors_origins" || key === "provider_keys") continue;
    await settings.set(key, value);
  }

  return getSettings();
}

function listProviders() {
  return providerIds().map((provider) => {
    const { models } = getProvider(provider);
    return {
      provider,
      models: models.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        context: model.context ?? null,
      })),
    };
  });
}

export default { getSettings, updateSettings, listProviders };
