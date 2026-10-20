// src/llm/registry.js
//
// The single window into every LLM provider. Agents ask for a provider by id
// and get { request, feed, models } — they never import a provider folder
// directly, so adding or removing a provider never touches agent code.
//
// A provider implementation must export:
//   request({ model, instruction, input, tools, signal, sentAttachments })
//     -> async generator yielding EVENT.* parts
//   feed({ reasoningSignature, toolCall, toolResult }) -> EVENT.* parts
// Models come from the root-level catalog (config/models.json); a provider
// may also declare its own list, which must pass the same validation.

import * as google from "./providers/google/google.js";
// Root-level model catalog (outside src/): the single legitimate "../"
// escape in src. Everything else inside src/ uses the #src alias.
import modelCatalog from "../../config/models.json" with { type: "json" };

function modelsFor(provider) {
  const list = modelCatalog[provider];
  if (!Array.isArray(list)) {
    return [];
  }

  for (const entry of list) {
    const valid =
      entry &&
      typeof entry.id === "string" &&
      entry.id.length > 0 &&
      Number.isInteger(entry.context) &&
      entry.context > 0;
    if (!valid) {
      throw new Error(
        `Invalid model entry for provider "${provider}" in config/models.json. Each entry needs { id, name, context }.`,
      );
    }
  }

  return list;
}

function validateProvider(id, impl) {
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("LLM provider id must be a non-empty string.");
  }
  for (const key of ["request", "feed"]) {
    if (typeof impl?.[key] !== "function") {
      throw new Error(`LLM provider "${id}" must export ${key}(). Got: ${typeof impl?.[key]}.`);
    }
  }
}

// Public provider table. A plain object (not a Map) so legacy
// `llm[provider]`, `provider in llm`, and Object.values(llm) call sites keep
// working while new code migrates to getProvider().
export const llm = {};

export function registerProvider(id, impl) {
  validateProvider(id, impl);
  llm[id] = {
    request: impl.request,
    feed: impl.feed,
    models: Array.isArray(impl.models) ? impl.models : modelsFor(id),
  };
  return llm[id];
}

export function getProvider(id) {
  const provider = llm[id];
  if (!provider) {
    const known = Object.keys(llm);
    throw new Error(
      `Unknown provider: ${id}. Available providers: ${known.length > 0 ? known.join(", ") : "(none)"}.`,
    );
  }
  return provider;
}

export function findModel(provider, modelId) {
  const entry = llm[provider];
  if (!entry) {
    return undefined;
  }
  return entry.models.find((model) => model.id === modelId);
}

export function listProviders() {
  return Object.keys(llm);
}

export function isKnownProvider(id) {
  return typeof id === "string" && id in llm;
}

export function isKnownModel(provider, modelId) {
  return findModel(provider, modelId) !== undefined;
}

registerProvider("google", google);
