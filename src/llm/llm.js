// src/llm/llm.js
//
// Thin backward-compatible wrapper over ./registry.js (same folder, so a
// relative import). New code should import { getProvider, findModel, … }
// from "#src/llm/registry.js" — reaching into `llm[provider]` directly is
// legacy and will warn once the second provider lands.
export {
  findModel,
  getProvider,
  isKnownModel,
  listProviders,
  llm,
  registerProvider,
} from "./registry.js";
