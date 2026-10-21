// src/llm/llm.js
//
// Thin backward-compatible wrapper over ./registry.js. Providers are reached
// through getProvider(); model metadata is reached through src/models/, not
// here.

export {
  getProvider,
  getProviderRegistry,
  isKnownProvider,
  listProviders,
  llm,
  registerProvider,
} from "./registry.js";
