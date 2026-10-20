// src/config/settings.js
//
// In-memory, validated settings snapshot with revision tracking. The rest of
// the app reads this snapshot; only this module touches the settings file.
// Writes are serialized, validated as a whole, and replaced atomically. A
// broken external edit keeps the last-known-good snapshot and records a safe
// error for /health instead of taking the gateway down.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CONFIG_FILENAME,
  dataDir,
  migrateLegacyData,
} from "#src/shared/data-dir.js";
import { writeFileAtomic } from "#src/infra/secure-file.js";
import {
  ConfigError,
  SETTINGS_DEFAULTS,
  deepFreeze,
  isRestartKey,
  validateConfig,
} from "./schema.js";
import { watchFile } from "./watcher.js";

const listeners = new Set();

let state = null;
let initPromise = null;
let mutationTail = Promise.resolve();
let watcher = null;

export function configPath() {
  return path.join(dataDir(), CONFIG_FILENAME);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeMessage(error) {
  if (error instanceof ConfigError) return error.message;
  if (error?.code === "ENOENT") return "settings file is missing";
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return "settings file is not readable or writable";
  }
  return "settings file could not be loaded";
}

function parseSettings(text) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new ConfigError("settings file is not valid JSON");
  }
}

function freezeSnapshot() {
  if (!state) return null;
  return Object.freeze({
    value: state.value,
    revision: state.revision,
    updatedAt: state.updatedAt,
    source: state.source,
    lastError: state.lastError,
    restartRequired: state.restartRequired,
    path: state.path,
  });
}

function notify() {
  const snapshot = freezeSnapshot();
  for (const listener of [...listeners]) {
    try {
      listener(snapshot);
    } catch {
      // A subscriber bug must not break the config mutation.
    }
  }
}

function enqueue(task) {
  const run = mutationTail.then(task, task);
  mutationTail = run.catch(() => {});
  return run;
}

async function readFileText() {
  try {
    return { text: await fs.readFile(configPath(), "utf8"), missing: false };
  } catch (error) {
    if (error?.code === "ENOENT") return { text: null, missing: true };
    throw new ConfigError(safeMessage(error));
  }
}

async function createDefaultFile() {
  const content = `${JSON.stringify(SETTINGS_DEFAULTS, null, 2)}\n`;
  await writeFileAtomic(configPath(), content);
  return content;
}

async function readInitialState() {
  let result = await readFileText();

  if (result.missing) {
    // Older layouts may have their settings in the repo checkout. Adopt them
    // once before falling back to a fresh default file.
    migrateLegacyData();
    result = await readFileText();
  }

  if (result.missing) {
    const content = await createDefaultFile();
    return { raw: parseSettings(content), source: "defaults" };
  }

  return { raw: parseSettings(result.text), source: "file" };
}

/**
 * Load and validate settings if needed. Idempotent and concurrency-safe.
 * Invalid config with no previous snapshot throws: boot must fail fast rather
 * than overwrite a file the user may be editing.
 */
export function initSettings() {
  if (state) return Promise.resolve(freezeSnapshot());
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const { raw, source } = await readInitialState();
    const value = deepFreeze(validateConfig(raw));
    state = {
      value,
      revision: 1,
      updatedAt: new Date().toISOString(),
      source,
      lastError: null,
      restartRequired: false,
      hash: hashValue(value),
      path: configPath(),
    };
    return freezeSnapshot();
  })().finally(() => {
    initPromise = null;
  });

  return initPromise;
}

/** Synchronous snapshot access for hot paths (CORS, health, auth). */
export function getSnapshot() {
  return freezeSnapshot();
}

function select(value, key) {
  if (typeof key === "string") {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`Unknown settings key: ${key}`);
    }
    return value[key];
  }

  if (Array.isArray(key)) {
    const data = {};
    for (const item of key) {
      if (typeof item !== "string") {
        throw new TypeError("Settings keys must be strings.");
      }
      if (!Object.hasOwn(value, item)) {
        throw new Error(`Unknown settings key: ${item}`);
      }
      data[item] = value[item];
    }
    return data;
  }

  throw new TypeError("Settings key must be a string or an array of strings.");
}

export async function get(key) {
  await initSettings();
  return select(state.value, key);
}

export function getSync(key) {
  if (!state) {
    throw new Error("Settings have not been initialized yet.");
  }
  return select(state.value, key);
}

function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changed.push(key);
    }
  }
  return changed;
}

async function writeCandidate(value) {
  await writeFileAtomic(configPath(), `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Replace a top-level settings key (or several) in one atomic write. The
 * returned snapshot is the state after this mutation.
 */
export function updateSettings(patch, { source = "api" } = {}) {
  if (
    typeof patch !== "object" ||
    patch === null ||
    Array.isArray(patch)
  ) {
    return Promise.reject(new ConfigError("settings patch must be an object"));
  }

  return initSettings().then(() =>
    enqueue(async () => {
      const nextValue = deepFreeze(
        validateConfig({ ...clone(state.value), ...patch }),
      );
      const changed = changedKeys(state.value, nextValue);

      try {
        await writeCandidate(nextValue);
      } catch (error) {
        state.lastError = safeMessage(error);
        notify();
        throw error;
      }

      state.value = nextValue;
      state.hash = hashValue(nextValue);
      state.revision += 1;
      state.updatedAt = new Date().toISOString();
      state.source = source;
      state.lastError = null;
      if (changed.some(isRestartKey)) {
        state.restartRequired = true;
      }

      notify();
      return freezeSnapshot();
    }),
  );
}

/** Compatibility helper used by the token bootstrap and older call sites. */
export async function set(key, value) {
  await updateSettings({ [key]: value });
  return true;
}

/**
 * Re-read the file. Used by the watcher and by tests that need deterministic
 * timing. Invalid content keeps the previous snapshot; API writes and watcher
 * reloads dedupe by content hash so one change never bumps the revision twice.
 */
export function reloadSettings() {
  return initSettings().then(() =>
    enqueue(async () => {
      let result;
      try {
        result = await readFileText();
      } catch (error) {
        state.lastError = safeMessage(error);
        notify();
        return freezeSnapshot();
      }

      if (result.missing) {
        state.lastError = "settings file is missing";
        notify();
        return freezeSnapshot();
      }

      let nextValue;
      try {
        nextValue = deepFreeze(validateConfig(parseSettings(result.text)));
      } catch (error) {
        state.lastError = safeMessage(error);
        notify();
        return freezeSnapshot();
      }

      const nextHash = hashValue(nextValue);
      const changed = changedKeys(state.value, nextValue);

      if (nextHash === state.hash) {
        if (state.lastError) {
          state.lastError = null;
          notify();
        }
        return freezeSnapshot();
      }

      state.value = nextValue;
      state.hash = nextHash;
      state.revision += 1;
      state.updatedAt = new Date().toISOString();
      state.source = "file";
      state.lastError = null;
      if (changed.some(isRestartKey)) {
        state.restartRequired = true;
      }

      notify();
      return freezeSnapshot();
    }),
  );
}

export function onChange(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("onChange requires a function.");
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Start polling the settings file. Idempotent. */
export function startSettingsWatcher() {
  if (watcher) return;
  watcher = watchFile(configPath(), () => {
    reloadSettings().catch((error) => {
      if (state) {
        state.lastError = safeMessage(error);
        notify();
      }
    });
  });
}

/** Stop the settings file watcher. Safe to call more than once. */
export function stopSettingsWatcher() {
  if (!watcher) return;
  watcher.stop();
  watcher = null;
}

export { ConfigError } from "./schema.js";
