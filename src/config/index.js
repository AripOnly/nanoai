// src/config/index.js
//
// The configuration door. Apps and the gateway use the snapshot API; only
// this module and the bootstrap path may mutate it.

export {
  configPath,
  getSnapshot,
  get,
  getSync,
  initSettings,
  onChange,
  reloadSettings,
  set,
  startSettingsWatcher,
  stopSettingsWatcher,
  updateSettings,
  ConfigError,
} from "./settings.js";

export {
  SETTINGS_DEFAULTS,
  SETTINGS_KEYS,
  SETTINGS_SCHEMA,
  isHotKey,
  isRestartKey,
  isSecretKey,
  validateConfig,
} from "./schema.js";

// Backwards-compatible object used by existing call sites.
import {
  get,
  getSnapshot,
  getSync,
  initSettings,
  onChange,
  reloadSettings,
  set,
  startSettingsWatcher,
  stopSettingsWatcher,
  updateSettings,
} from "./settings.js";

export const settings = {
  get,
  getSync,
  getSnapshot,
  init: initSettings,
  onChange,
  reload: reloadSettings,
  set,
  startWatcher: startSettingsWatcher,
  stopWatcher: stopSettingsWatcher,
  update: updateSettings,
};
