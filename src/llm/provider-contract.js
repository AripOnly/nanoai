// src/llm/provider-contract.js
//
// The only provider surface agent/core code may depend on. A provider adapter
// owns SDK import, auth, endpoint mapping, request/response normalization, and
// client lifecycle; it never exposes a model list and never reads settings.
//
// Required shape:
//   {
//     id: "google",
//     supportedWires: ["google-interactions"],
//     configure({ credentials, endpoint }),   // idempotent per fingerprint
//     request({ model, instruction, input, tools, signal, sentAttachments })
//       -> AsyncIterable<ProviderEvent>,
//     continue({ reasoningSignature, toolCall, toolResult }) -> ProviderPart[],
//     dispose()
//   }
//
// `continue` is required; `feed` remains accepted as a legacy alias inside the
// agent loop while older adapters migrate, but a provider must still expose
// `continue` to register.

import { EVENT } from "#src/shared/event-type.js";

/**
 * The only event roles a provider may yield from request(). Everything else
 * (compaction markers, tool updates, done framing) belongs to the runtime or
 * gateway, not the provider.
 *
 * @typedef {Object} ProviderEvent
 * @property {string} role One of PROVIDER_EVENT_ROLES.
 * @property {Object} content Provider-neutral event payload.
 *
 * @typedef {Object} ProviderPart
 * @property {string} role Conversation role retained for the next request.
 * @property {Object} content Provider-neutral part payload.
 */

export const PROVIDER_EVENT_ROLES = Object.freeze([
  EVENT.ASSISTANT,
  EVENT.TOKEN,
  EVENT.REASONING_SUMMARY,
  EVENT.REASONING_SIGNATURE,
  EVENT.TOOL_CALL,
  EVENT.ERROR,
]);

export class ProviderContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderContractError";
    this.code = "PROVIDER_CONTRACT_INVALID";
  }
}

export function assertProviderContract(id, impl) {
  if (typeof id !== "string" || id.trim() === "") {
    throw new ProviderContractError("LLM provider id must be a non-empty string.");
  }

  if (!impl || typeof impl !== "object") {
    throw new ProviderContractError(`LLM provider "${id}" must be an object.`);
  }

  if (typeof impl.id !== "string" || impl.id !== id) {
    throw new ProviderContractError(
      `LLM provider "${id}" must expose matching id: "${id}".`,
    );
  }

  if (
    !Array.isArray(impl.supportedWires) ||
    impl.supportedWires.length === 0 ||
    !impl.supportedWires.every(
      (wire) => typeof wire === "string" && wire.trim() !== "",
    )
  ) {
    throw new ProviderContractError(
      `LLM provider "${id}" must declare a non-empty supportedWires array.`,
    );
  }

  if (typeof impl.configure !== "function") {
    throw new ProviderContractError(
      `LLM provider "${id}" must export configure().`,
    );
  }

  if (typeof impl.request !== "function") {
    throw new ProviderContractError(
      `LLM provider "${id}" must export request().`,
    );
  }

  if (typeof impl.continue !== "function") {
    throw new ProviderContractError(
      `LLM provider "${id}" must export continue().`,
    );
  }

  if (typeof impl.dispose !== "function") {
    throw new ProviderContractError(
      `LLM provider "${id}" must export dispose().`,
    );
  }

  if (Object.hasOwn(impl, "models")) {
    throw new ProviderContractError(
      `LLM provider "${id}" must not expose a model catalog; model metadata belongs in config/models.json.`,
    );
  }

  return impl;
}

export function providerSupportsWire(impl, wire) {
  return (
    Array.isArray(impl?.supportedWires) && impl.supportedWires.includes(wire)
  );
}
