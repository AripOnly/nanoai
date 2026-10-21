// src/llm/registry.js
//
// The single window into every LLM provider. Agents never import a provider
// folder directly; the runtime resolves a model through the model registry and
// gets the configured adapter from here.
//
// The registry is intentionally provider-only: it does not know model
// metadata, credentials, endpoints, or settings. Model data lives in
// src/models/.

import { createGoogleProvider } from "./providers/google/google.js";
import { createOpenAIProvider } from "./providers/openai/openai.js";
import { createAnthropicProvider } from "./providers/anthropic/anthropic.js";
import { createOpenRouterProvider } from "./providers/openrouter/openrouter.js";
import { createOpenCodeZenProvider } from "./providers/opencode-zen/opencode-zen.js";
import { assertProviderContract } from "./provider-contract.js";

// Public provider table. A null-prototype object so ids such as "toString"
// or "__proto__" cannot collide with Object.prototype. Legacy
// `llm[provider]`, `provider in llm`, and Object.values(llm) call sites keep
// working.
export const llm = Object.create(null);

export function registerProvider(id, impl) {
  assertProviderContract(id, impl);
  llm[id] = impl;
  return llm[id];
}

export function getProvider(id) {
  const provider = Object.hasOwn(llm, id) ? llm[id] : undefined;
  if (!provider) {
    const known = Object.keys(llm);
    throw new Error(
      `Unknown provider: ${id}. Available providers: ${known.length > 0 ? known.join(", ") : "(none)"}.`,
    );
  }
  return provider;
}

export function listProviders() {
  return Object.keys(llm);
}

export function isKnownProvider(id) {
  return typeof id === "string" && Object.hasOwn(llm, id);
}

/** Provider registry view passed to the model resolver and runtime. */
export function getProviderRegistry() {
  return Object.freeze({
    get: getProvider,
    has: isKnownProvider,
    list: listProviders,
  });
}

registerProvider("google", createGoogleProvider());
registerProvider("openai", createOpenAIProvider());
registerProvider("anthropic", createAnthropicProvider());
registerProvider("openrouter", createOpenRouterProvider());
registerProvider("opencode-zen", createOpenCodeZenProvider());
