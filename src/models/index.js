// src/models/index.js
//
// The model module door. The shipped catalog is loaded synchronously at
// import time: it is packaged data, not user input, so a broken install fails
// fast instead of serving a half-configured agent. The live store below is
// revisioned and hot-reloadable; a bad external edit keeps the last good
// snapshot and records `lastError`.

import { fileURLToPath } from "node:url";
import {
  createCatalogStore,
  loadCatalogSync,
} from "./catalog.js";
import { createModelRegistry } from "./registry.js";

export {
  CATALOG_SCHEMA_VERSION,
  CatalogError,
  MODEL_CAPABILITY_KEYS,
  MODEL_STATUSES,
  createCatalogStore,
  loadCatalog,
  loadCatalogSync,
  validateCatalog,
} from "./catalog.js";
export { ModelRefError, formatModelRef, parseModelRef } from "./ref.js";
export { createModelRegistry } from "./registry.js";
export {
  ModelResolveError,
  RESOLVE_ERROR_CODES,
  createModelResolver,
  resolveModel,
} from "./resolver.js";

const defaultPath = fileURLToPath(
  new URL("../../config/models.json", import.meta.url),
);

const initialCatalog = loadCatalogSync(defaultPath);

export const modelCatalog = createCatalogStore({
  filePath: defaultPath,
  initial: initialCatalog,
});

/** Current immutable catalog snapshot (never null after import). */
export function getCatalogSnapshot() {
  return modelCatalog.getSnapshot();
}

/** Immutable query view for the current snapshot. */
export function getModelRegistry() {
  return createModelRegistry(modelCatalog.getSnapshot());
}

export function listModels() {
  return [...modelCatalog.getModels()];
}

export function listModelProviders() {
  return modelCatalog.listProviders();
}

export function findModel(provider, id) {
  return modelCatalog.findModel(provider, id);
}

/** Boot-time: make sure the snapshot exists before the first request. */
export async function initModelCatalog() {
  return modelCatalog.init();
}

export function startModelCatalogWatcher() {
  return modelCatalog.startWatcher();
}

export function stopModelCatalogWatcher() {
  modelCatalog.stopWatcher();
}

export function reloadModelCatalog() {
  return modelCatalog.reload();
}

export function onModelCatalogChange(listener) {
  return modelCatalog.onChange(listener);
}
