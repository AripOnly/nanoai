// src/config/schema.js
//
// One declaration for every user setting: default, validator, whether it is a
// secret, and whether changing it can take effect without a restart. Settings
// are plain JSON; this module never talks to the filesystem or the network.

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
    this.code = "CONFIG_INVALID";
  }
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function fail(key, message) {
  throw new ConfigError(`${key} ${message}`);
}

function validateString(value, key) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(key, "must be a non-empty string");
  }
  return value;
}

function validateSecret(value, key) {
  if (value === null) return null;
  return validateString(value, key);
}

function validateProviderKeys(value, key) {
  if (!isPlainObject(value)) {
    fail(key, "must be an object");
  }
  const result = {};
  for (const [provider, secret] of Object.entries(value)) {
    if (typeof provider !== "string" || provider.trim() === "") {
      fail(key, "names must be non-empty");
    }
    if (secret !== null && (typeof secret !== "string" || secret.trim() === "")) {
      fail(`${key}["${provider}"]`, "must be a non-empty string or null");
    }
    result[provider] = secret;
  }
  return result;
}

function validateProviderEndpoints(value, key) {
  if (!isPlainObject(value)) {
    fail(key, "must be an object");
  }
  const result = {};
  for (const [provider, endpoint] of Object.entries(value)) {
    if (typeof provider !== "string" || provider.trim() === "") {
      fail(key, "names must be non-empty");
    }
    if (endpoint === null) {
      result[provider] = null;
      continue;
    }
    if (typeof endpoint !== "string" || endpoint.trim() === "") {
      fail(`${key}["${provider}"]`, "must be a non-empty URL or null");
    }
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      fail(`${key}["${provider}"]`, "must be a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      fail(`${key}["${provider}"]`, "must use http or https");
    }
    result[provider] = endpoint;
  }
  return result;
}

function validateCompaction(value, key) {
  if (!isPlainObject(value)) {
    fail(key, "must be an object");
  }
  const unknown = Object.keys(value).filter(
    (item) => item !== "ratio" && item !== "keep_turn",
  );
  if (unknown.length > 0) {
    fail(key, `contains an unknown key "${unknown[0]}"`);
  }
  const result = { ...value };
  if (!Number.isInteger(result.ratio) || result.ratio < 1 || result.ratio > 100) {
    fail(`${key}.ratio`, "must be an integer between 1 and 100");
  }
  if (!Number.isInteger(result.keep_turn) || result.keep_turn < 1) {
    fail(`${key}.keep_turn`, "must be an integer >= 1");
  }
  return result;
}

function validateCorsOrigins(value, key) {
  if (!Array.isArray(value)) {
    fail(key, "must be an array of non-empty strings");
  }
  const result = [];
  for (const origin of value) {
    if (typeof origin !== "string" || origin.trim() === "") {
      fail(key, "must be an array of non-empty strings");
    }
    if (!result.includes(origin)) result.push(origin);
  }
  return result;
}

function validateGateway(value, key) {
  if (!isPlainObject(value)) {
    fail(key, "must be an object");
  }
  const unknown = Object.keys(value).filter(
    (item) => item !== "host" && item !== "port",
  );
  if (unknown.length > 0) {
    fail(key, `contains an unknown key "${unknown[0]}"`);
  }
  const host = value.host ?? null;
  const port = value.port ?? null;
  if (host !== null && (typeof host !== "string" || host.trim() === "")) {
    fail(`${key}.host`, "must be a non-empty string or null");
  }
  if (
    port !== null &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    fail(`${key}.port`, "must be an integer between 1 and 65535 or null");
  }
  return { host, port };
}

export const JOBS_DEFAULTS = Object.freeze({
  enabled: true,
  maxRunning: 4,
  maxPerSession: 2,
  defaultTimeoutMs: 30 * 60 * 1000,
  maxTimeoutMs: 24 * 60 * 60 * 1000,
  pollIntervalMs: 2000,
  maxLogBytes: 50 * 1024 * 1024,
  maxTotalLogBytes: 100 * 1024 * 1024,
  retentionDays: 7,
  autoContinue: true,
  notifyDefault: "always",
});

const JOB_NOTIFY_DEFAULTS = Object.freeze(["always", "failure", "never"]);

function validateJobs(value, key) {
  if (!isPlainObject(value)) {
    fail(key, "must be an object");
  }
  const unknown = Object.keys(value).filter(
    (item) => !Object.hasOwn(JOBS_DEFAULTS, item),
  );
  if (unknown.length > 0) {
    fail(key, `contains an unknown key "${unknown[0]}"`);
  }
  const result = { ...JOBS_DEFAULTS, ...value };
  const integer = (name, min, max) => {
    const number = result[name];
    if (!Number.isInteger(number) || number < min || number > max) {
      fail(
        `${key}.${name}`,
        `must be an integer between ${min} and ${max}`,
      );
    }
  };
  if (typeof result.enabled !== "boolean") {
    fail(`${key}.enabled`, "must be a boolean");
  }
  integer("maxRunning", 1, 64);
  integer("maxPerSession", 1, 64);
  integer("defaultTimeoutMs", 1_000, 24 * 60 * 60 * 1000);
  integer("maxTimeoutMs", 1_000, 24 * 60 * 60 * 1000);
  if (result.defaultTimeoutMs > result.maxTimeoutMs) {
    fail(
      `${key}.defaultTimeoutMs`,
      "must be less than or equal to maxTimeoutMs",
    );
  }
  integer("pollIntervalMs", 250, 60_000);
  integer("maxLogBytes", 1024, 1024 * 1024 * 1024);
  integer("maxTotalLogBytes", 1024, 10 * 1024 * 1024 * 1024);
  integer("retentionDays", 0, 3650);
  if (typeof result.autoContinue !== "boolean") {
    fail(`${key}.autoContinue`, "must be a boolean");
  }
  if (!JOB_NOTIFY_DEFAULTS.includes(result.notifyDefault)) {
    fail(
      `${key}.notifyDefault`,
      `must be one of: ${JOB_NOTIFY_DEFAULTS.join(", ")}`,
    );
  }
  return result;
}

export const SKILLS_DEFAULTS = Object.freeze({
  enabled: true,
  autoLoadTrusted: true,
  allowUntrustedAutoLoad: false,
  maxCatalogEntries: 200,
  maxSkillBytes: 131072,
  maxSupportingFileBytes: 16384,
});

function validateSkills(value, key) {
  if (!isPlainObject(value)) {
    fail(key, "must be an object");
  }
  const unknown = Object.keys(value).filter(
    (item) => !Object.hasOwn(SKILLS_DEFAULTS, item),
  );
  if (unknown.length > 0) {
    fail(key, `contains an unknown key "${unknown[0]}"`);
  }
  const result = { ...SKILLS_DEFAULTS, ...value };
  for (const name of ["enabled", "autoLoadTrusted", "allowUntrustedAutoLoad"]) {
    if (typeof result[name] !== "boolean") {
      fail(`${key}.${name}`, "must be a boolean");
    }
  }
  const integer = (name, min, max) => {
    const number = result[name];
    if (!Number.isInteger(number) || number < min || number > max) {
      fail(
        `${key}.${name}`,
        `must be an integer between ${min} and ${max}`,
      );
    }
  };
  integer("maxCatalogEntries", 1, 1000);
  integer("maxSkillBytes", 1024, 1024 * 1024);
  integer("maxSupportingFileBytes", 1024, 1024 * 1024);
  return result;
}

function validateModel(value, key) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(key, "must be a non-empty string");
  }
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) {
    fail(key, 'must use the "provider/model" format');
  }
  return value;
}

export const SETTINGS_SCHEMA = Object.freeze({
  username: {
    hot: true,
    secret: false,
    validate: validateString,
  },
  model: {
    hot: true,
    secret: false,
    validate: validateModel,
  },
  api_key: {
    hot: true,
    secret: true,
    validate: validateSecret,
  },
  provider_keys: {
    hot: true,
    secret: true,
    validate: validateProviderKeys,
  },
  provider_endpoints: {
    hot: true,
    secret: false,
    validate: validateProviderEndpoints,
  },
  serper_api_key: {
    hot: true,
    secret: true,
    validate: validateSecret,
  },
  compaction: {
    hot: true,
    secret: false,
    validate: validateCompaction,
  },
  cors_origins: {
    hot: true,
    secret: false,
    validate: validateCorsOrigins,
  },
  gateway_token: {
    hot: true,
    secret: true,
    validate: validateSecret,
  },
  gateway: {
    hot: false,
    restart: true,
    secret: false,
    validate: validateGateway,
  },
  jobs: {
    hot: true,
    secret: false,
    validate: validateJobs,
  },
  skills: {
    hot: true,
    secret: false,
    validate: validateSkills,
  },
});

export const SETTINGS_KEYS = Object.freeze(Object.keys(SETTINGS_SCHEMA));

export const SETTINGS_DEFAULTS = deepFreeze({
  username: "your name",
  model: "google/gemini-3.1-flash-lite",
  api_key: null,
  provider_keys: {},
  provider_endpoints: {},
  serper_api_key: null,
  compaction: {
    ratio: 85,
    keep_turn: 2,
  },
  cors_origins: [],
  gateway_token: null,
  gateway: {
    host: null,
    port: null,
  },
  jobs: JOBS_DEFAULTS,
  skills: SKILLS_DEFAULTS,
});

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function isHotKey(key) {
  return SETTINGS_SCHEMA[key]?.hot === true;
}

export function isRestartKey(key) {
  return SETTINGS_SCHEMA[key]?.restart === true;
}

export function isSecretKey(key) {
  return SETTINGS_SCHEMA[key]?.secret === true;
}

function applyDefaults(raw) {
  const candidate = { ...deepClone(SETTINGS_DEFAULTS), ...raw };
  if (isPlainObject(raw.compaction)) {
    candidate.compaction = {
      ...SETTINGS_DEFAULTS.compaction,
      ...raw.compaction,
    };
  }
  if (isPlainObject(raw.gateway)) {
    candidate.gateway = {
      ...SETTINGS_DEFAULTS.gateway,
      ...raw.gateway,
    };
  }
  if (isPlainObject(raw.jobs)) {
    candidate.jobs = {
      ...SETTINGS_DEFAULTS.jobs,
      ...raw.jobs,
    };
  }
  if (isPlainObject(raw.skills)) {
    candidate.skills = {
      ...SETTINGS_DEFAULTS.skills,
      ...raw.skills,
    };
  }
  return candidate;
}

/**
 * Validate a whole settings object and return a normalized copy. Unknown keys
 * are rejected rather than silently carried forward; a typo in a secret key
 * would otherwise look like it was saved.
 */
export function validateConfig(raw) {
  if (!isPlainObject(raw)) {
    throw new ConfigError("settings must be a JSON object");
  }

  const unknown = Object.keys(raw).filter(
    (key) => !Object.hasOwn(SETTINGS_SCHEMA, key),
  );
  if (unknown.length > 0) {
    throw new ConfigError(`unknown settings key "${unknown[0]}"`);
  }

  const candidate = applyDefaults(raw);
  const validated = {};
  for (const [key, definition] of Object.entries(SETTINGS_SCHEMA)) {
    validated[key] = definition.validate(candidate[key], key);
  }
  return validated;
}

export function configHash(value) {
  // The snapshot's own hash is computed by settings.js with a stable clone.
  return JSON.stringify(value);
}
