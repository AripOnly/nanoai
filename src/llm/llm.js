// src/providers/generate.js

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

export const llm = {
  google: {
    request: google.request,
    feed: google.feed,
    models: modelsFor("google"),
  },
};

export function findModel(provider, modelId) {
  const entry = llm[provider];
  if (!entry) {
    return undefined;
  }
  return entry.models.find((model) => model.id === modelId);
}