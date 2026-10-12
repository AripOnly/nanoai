// src/config/config.js

import fs from "fs/promises";
import path from "path";
import { CONFIG_FILENAME, dataDir, migrateLegacyData } from "#src/shared/data-dir.js";

function settingsPath() {
  return path.join(dataDir(), CONFIG_FILENAME);
}

/** Absolute path of the user config file (useful for tests and tooling). */
export function configPath() {
  return settingsPath();
}

let cachedSettings = null;
let cachePromise = null;

async function load() {
  const SETTINGS_PATH = settingsPath();
  try {
    const text = await fs.readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(text);
  } catch (error) {
    if (error.code === "ENOENT") {
      // First run (or fresh data dir): adopt data written by older layouts,
      // then fall back to defaults.
      migrateLegacyData();
      try {
        const text = await fs.readFile(SETTINGS_PATH, "utf-8");
        return JSON.parse(text);
      } catch (retry) {
        if (retry.code !== "ENOENT") throw retry;
      }
      const data = JSON.stringify(
        {
          username: "your name",
          model: "google/gemini-3.1-flas-lite",
          api_key: null,
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
  if (cachedSettings) {
    return cachedSettings;
  }

  if (!cachePromise) {
    cachePromise = load().then((settings) => {
      cachedSettings = settings;
      return settings;
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
  return true;
}

export const settings = { get, set };
