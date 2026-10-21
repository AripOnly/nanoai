// src/models/registry.js
//
// An immutable query view over one catalog snapshot. The registry is created
// per turn (from the snapshot captured at turn start), so a hot-reloaded
// catalog never changes metadata halfway through a turn.

export function createModelRegistry(catalog) {
  if (!catalog || !Array.isArray(catalog.models)) {
    throw new TypeError("createModelRegistry requires a catalog snapshot.");
  }

  const models = Object.freeze([...catalog.models]);
  const byKey = new Map();
  const byProvider = new Map();

  for (const model of models) {
    const key = `${model.provider}/${model.id}`;
    byKey.set(key, model);
    if (!byProvider.has(model.provider)) byProvider.set(model.provider, []);
    byProvider.get(model.provider).push(model);
  }

  const providerNames = Object.freeze([...byProvider.keys()]);
  for (const [provider, entries] of byProvider) {
    byProvider.set(provider, Object.freeze(entries));
  }

  return Object.freeze({
    revision: catalog.revision ?? null,
    models() {
      return models;
    },
    providers() {
      return providerNames;
    },
    byProvider(provider) {
      return byProvider.get(provider) ?? Object.freeze([]);
    },
    find(provider, id) {
      return byKey.get(`${provider}/${id}`);
    },
    has(provider, id) {
      return byKey.has(`${provider}/${id}`);
    },
  });
}
