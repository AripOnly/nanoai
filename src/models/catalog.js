// src/models/catalog.js
//
// The model registry is pure data: it never imports a provider SDK, an
// adapter, settings, sessions, agents, or tools. config/models.json is loaded
// and validated here, then exposed as an immutable, revisioned snapshot.
//
// Invalid external edits never take down a running process: the last known
// good snapshot keeps serving and the error is reported through the snapshot
// so /health and GET /api/v1/models can surface it.

import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { watchFile } from "#src/infra/watch-file.js";

export const CATALOG_SCHEMA_VERSION = 2;

export const MODEL_STATUSES = Object.freeze([
  "active",
  "preview",
  "deprecated",
  "disabled",
]);

export const MODEL_CAPABILITY_KEYS = Object.freeze([
  "streaming",
  "toolCalling",
  "parallelToolCalls",
  "reasoning",
  "vision",
  "pdf",
  "audio",
  "structuredOutput",
]);

const MODEL_KEYS = Object.freeze([
  "provider",
  "id",
  "name",
  "wire",
  "contextWindow",
  "maxOutputTokens",
  "capabilities",
  "status",
]);

const CATALOG_KEYS = Object.freeze(["schemaVersion", "models"]);

export class CatalogError extends Error {
  constructor(message, { code = "MODEL_CATALOG_INVALID" } = {}) {
    super(message);
    this.name = "CatalogError";
    this.code = code;
  }
}

function invalid(message) {
  throw new CatalogError(message);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function assertOnlyKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      invalid(`${label} contains an unknown key "${key}".`);
    }
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    invalid(`${label} must be a positive integer.`);
  }
  return value;
}

function normalizeCapabilities(value, label) {
  if (value === undefined) {
    return Object.freeze(
      Object.fromEntries(MODEL_CAPABILITY_KEYS.map((key) => [key, false])),
    );
  }

  if (!isPlainObject(value)) {
    invalid(`${label} must be an object.`);
  }

  assertOnlyKeys(value, MODEL_CAPABILITY_KEYS, label);

  const capabilities = {};
  for (const key of MODEL_CAPABILITY_KEYS) {
    const raw = value[key];
    if (raw === undefined) {
      capabilities[key] = false;
      continue;
    }
    if (typeof raw !== "boolean") {
      invalid(`${label}.${key} must be a boolean.`);
    }
    capabilities[key] = raw;
  }
  return Object.freeze(capabilities);
}

function normalizeModel(entry, index) {
  const label = `models[${index}]`;

  if (!isPlainObject(entry)) {
    invalid(`${label} must be an object.`);
  }

  assertOnlyKeys(entry, MODEL_KEYS, label);

  const provider = requireNonEmptyString(entry.provider, `${label}.provider`);
  const id = requireNonEmptyString(entry.id, `${label}.id`);
  const name = requireNonEmptyString(entry.name, `${label}.name`);
  const wire = requireNonEmptyString(entry.wire, `${label}.wire`);
  const contextWindow = requirePositiveInteger(
    entry.contextWindow,
    `${label}.contextWindow`,
  );
  const maxOutputTokens = requirePositiveInteger(
    entry.maxOutputTokens,
    `${label}.maxOutputTokens`,
  );
  const capabilities = normalizeCapabilities(
    entry.capabilities,
    `${label}.capabilities`,
  );

  const status = entry.status ?? "active";
  if (!MODEL_STATUSES.includes(status)) {
    invalid(
      `${label}.status must be one of: ${MODEL_STATUSES.join(", ")}.`,
    );
  }

  return Object.freeze({
    provider,
    id,
    name,
    wire,
    contextWindow,
    maxOutputTokens,
    capabilities,
    status,
  });
}

/** Validate an already-parsed catalog document and freeze it. */
export function validateCatalog(raw) {
  if (!isPlainObject(raw)) {
    invalid("Model catalog must be a JSON object.");
  }

  assertOnlyKeys(raw, CATALOG_KEYS, "Model catalog");

  if (raw.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    invalid(
      `Model catalog schemaVersion must be ${CATALOG_SCHEMA_VERSION}. Run the migration or restore the shipped config/models.json.`,
    );
  }

  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    invalid("Model catalog must contain a non-empty models array.");
  }

  const models = raw.models.map(normalizeModel);
  const seen = new Set();
  for (const model of models) {
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) {
      invalid(`Model catalog contains a duplicate entry: ${key}.`);
    }
    seen.add(key);
  }

  return Object.freeze({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    models: Object.freeze(models),
  });
}

function parseCatalogText(text) {
  const cleaned =
    typeof text === "string" && text.charCodeAt(0) === 0xfeff
      ? text.slice(1)
      : text;

  let raw;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    invalid("Model catalog is not valid JSON.");
  }

  return validateCatalog(raw);
}

function hashCatalog(catalog) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(catalog))
    .digest("hex");
}

/** Synchronous load used by the composition root so the first read is ready. */
export function loadCatalogSync(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      invalid(`Model catalog not found at ${filePath}.`);
    }
    throw error;
  }
  return parseCatalogText(text);
}

export async function loadCatalog(filePath) {
  let text;
  try {
    text = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      invalid(`Model catalog not found at ${filePath}.`);
    }
    throw error;
  }
  return parseCatalogText(text);
}

function createSnapshot(catalog, source, revision) {
  return Object.freeze({
    ...catalog,
    revision,
    source,
    updatedAt: new Date().toISOString(),
    lastError: null,
    hash: hashCatalog(catalog),
  });
}

/**
 * Revisioned catalog store with last-known-good semantics.
 *
 * - init()/getSnapshot() is synchronous after construction when `initial` is
 *   supplied (the packaging path reads the shipped catalog before boot).
 * - reload() reads the file again. An invalid file keeps the current snapshot
 *   and records `lastError`; it never swaps in broken data.
 * - startWatcher() polls the file; stopWatcher() is idempotent.
 */
export function createCatalogStore({
  filePath,
  initial = null,
  interval = 1000,
  debounceMs = 150,
} = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new TypeError("createCatalogStore requires a filePath.");
  }

  let snapshot = initial
    ? createSnapshot(initial, initial.source ?? "initial", 1)
    : null;
  let watcher = null;
  let loadPromise = null;
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A bad listener must not break reload or other listeners.
      }
    }
  }

  function apply(catalog, source) {
    const hash = hashCatalog(catalog);
    if (snapshot && snapshot.hash === hash) {
      // The file is back to the last known good content. Clear any error from
      // an earlier invalid edit without bumping the revision.
      if (snapshot.lastError) {
        snapshot = Object.freeze({ ...snapshot, lastError: null });
        notify();
      }
      return snapshot;
    }
    const revision = (snapshot?.revision ?? 0) + 1;
    snapshot = createSnapshot(catalog, source, revision);
    notify();
    return snapshot;
  }

  async function init() {
    if (snapshot) return snapshot;
    if (!loadPromise) {
      loadPromise = loadCatalog(filePath).then((catalog) => {
        if (!snapshot) snapshot = createSnapshot(catalog, "file", 1);
        return snapshot;
      });
    }
    return loadPromise;
  }

  async function reload() {
    try {
      const catalog = await loadCatalog(filePath);
      return apply(catalog, "file");
    } catch (error) {
      if (!snapshot) throw error;
      snapshot = Object.freeze({
        ...snapshot,
        lastError: {
          code: error?.code ?? "MODEL_CATALOG_INVALID",
          message: error?.message ?? "Model catalog could not be reloaded.",
        },
      });
      notify();
      return snapshot;
    }
  }

  function startWatcher() {
    if (watcher) return watcher;
    watcher = watchFile(
      filePath,
      () => {
        void reload();
      },
      { interval, debounceMs },
    );
    return watcher;
  }

  function stopWatcher() {
    if (!watcher) return;
    watcher.stop();
    watcher = null;
  }

  return Object.freeze({
    filePath,
    init,
    reload,
    startWatcher,
    stopWatcher,
    onChange(listener) {
      if (typeof listener !== "function") {
        throw new TypeError("onChange requires a function.");
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    isInitialized() {
      return snapshot !== null;
    },
    getModels() {
      return snapshot?.models ?? [];
    },
    listProviders() {
      const providers = new Set();
      for (const model of snapshot?.models ?? []) providers.add(model.provider);
      return [...providers];
    },
    findModel(provider, id) {
      return (snapshot?.models ?? []).find(
        (model) => model.provider === provider && model.id === id,
      );
    },
  });
}
