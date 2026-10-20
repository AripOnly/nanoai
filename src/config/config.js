// src/config/config.js

import fs from "fs/promises";
import path from "path";
import { CONFIG_FILENAME, dataDir, migrateLegacyData } from "#src/shared/data-dir.js";

function settingsPath() {
  return path.join(dataDir(), CONFIG_FILENAME);
}

// Windows editors may save a UTF-8 BOM (PowerShell 'Set-Content -Encoding
// utf8', some Notepad builds); JSON.parse would reject it — strip it first.
function parseSettings(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

/** Absolute path of the user config file (useful for tests and tooling). */
export function configPath() {
  return settingsPath();
}

// The settings file is plain JSON the user may edit while the gateway runs.
// Cache it briefly instead of forever: at most one file read per window, and
// external edits (rotated token, new CORS origins, new model) become visible
// without restarting the gateway.
const CACHE_TTL_MS = 5_000;

let cachedSettings = null;
let cachedAt = 0;
let cachePromise = null;

async function load() {
  const SETTINGS_PATH = settingsPath();
  try {
    const text = await fs.readFile(SETTINGS_PATH, "utf-8");
    return parseSettings(text);
  } catch (error) {
    if (error.code === "ENOENT") {
      // First run (or fresh data dir): adopt data written by older layouts,
      // then fall back to defaults.
      migrateLegacyData();
      try {
        const text = await fs.readFile(SETTINGS_PATH, "utf-8");
        return parseSettings(text);
      } catch (retry) {
        if (retry.code !== "ENOENT") throw retry;
      }
      const data = JSON.stringify(
        {
          username: "your name",
          model: "google/gemini-3.1-flash-lite",
          api_key: null,
          provider_keys: {},
          serper_api_key: null,
          compaction: {
            ratio: 85,
            keep_turn: 2,
          },
        },
        null,
        2,
      );

      await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
      await fs.writeFile(SETTINGS_PATH, data, "utf-8");

      return JSON.parse(data);
    }

    throw error;
  }
}

async function getSettings() {
  if (cachedSettings && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedSettings;
  }

  if (!cachePromise) {
    cachePromise = load()
      .then((settings) => {
        cachedSettings = settings;
        cachedAt = Date.now();
        return settings;
      })
      .catch((error) => {
        // A half-written file (editor mid-save) must not take the gateway
        // down: keep serving the last good copy when we have one.
        if (cachedSettings) {
          return cachedSettings;
        }
        throw error;
      })
      .finally(() => {
        cachePromise = null;
      });
  }

  return cachePromise;
}

async function get(key) {
  const settingsData = await getSettings();

  // Get a single setting.
  if (typeof key === "string") {
    if (!(key in settingsData)) {
      throw new Error(`Unknown settings key: ${key}`);
    }

    return settingsData[key];
  }

  // Get multiple settings.
  if (Array.isArray(key)) {
    const data = {};

    for (const item of key) {
      if (typeof item !== "string") {
        throw new TypeError("Settings keys must be strings.");
      }

      if (!(item in settingsData)) {
        throw new Error(`Unknown settings key: ${item}`);
      }

      data[item] = settingsData[item];
    }

    return data;
  }

  throw new TypeError("Settings key must be a string or an array of strings.");
}

async function set(key, value) {
  const data = await getSettings();
  data[key] = value;
  await fs.writeFile(settingsPath(), JSON.stringify(data, null, 2), "utf-8");

  cachedSettings = data;
  cachedAt = Date.now();
  return true;
}

export const settings = { get, set };
