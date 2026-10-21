// src/llm/providers/shared/openai-compatible.js
//
// One adapter factory for every OpenAI-compatible HTTP surface. The provider
// wrapper supplies its id, endpoint default, and headers; the shared layer
// owns the SDK import, credential fingerprint, client lifecycle, and the two
// supported wires.

import crypto from "node:crypto";
import OpenAI from "openai";
import { EVENT } from "#src/shared/event-type.js";
import { expandAttachments } from "#src/llm/attachment-expansion.js";
import { providerErrorEvent } from "#src/llm/provider-error.js";
import { toolContinuation } from "./continuation.js";
import { requestChat } from "./openai-chat.js";
import { requestResponses } from "./openai-responses.js";

export const OPENAI_RESPONSES_WIRE = "openai-responses";
export const OPENAI_CHAT_WIRE = "openai-chat";

function fingerprint(apiKey, endpoint) {
  return crypto
    .createHash("sha256")
    .update(`${apiKey}\n${endpoint ?? ""}`)
    .digest("hex");
}

function apiKeyOf(credentials) {
  return typeof credentials === "string"
    ? credentials
    : credentials?.apiKey ?? credentials?.api_key;
}

/**
 * @param {object} options
 * @param {string} options.id
 * @param {string} [options.label]
 * @param {string[]} [options.supportedWires]
 * @param {string|null} [options.defaultBaseURL]
 * @param {object|null} [options.defaultHeaders]
 * @param {Function} [options.clientFactory]
 * @param {boolean} [options.preserveToolSignatures]
 */
export function createOpenAICompatibleProvider({
  id,
  label = id,
  supportedWires = [OPENAI_RESPONSES_WIRE, OPENAI_CHAT_WIRE],
  defaultBaseURL = null,
  defaultHeaders = null,
  clientFactory = (options) => new OpenAI(options),
  preserveToolSignatures = false,
} = {}) {
  let client = null;
  let clientFingerprint = null;
  let secret = null;

  const provider = {
    id,
    supportedWires: Object.freeze([...supportedWires]),

    configure({ credentials, endpoint = null } = {}) {
      const apiKey = apiKeyOf(credentials);
      if (typeof apiKey !== "string" || apiKey.trim() === "") {
        throw new Error(`${label} provider requires an API key.`);
      }

      const baseURL = endpoint || defaultBaseURL || null;
      const next = fingerprint(apiKey.trim(), baseURL);
      if (client && clientFingerprint === next) return provider;

      client = clientFactory({
        apiKey: apiKey.trim(),
        ...(baseURL ? { baseURL } : {}),
        ...(defaultHeaders ? { defaultHeaders } : {}),
      });
      clientFingerprint = next;
      secret = apiKey.trim();
      return provider;
    },

    async *request(request) {
      const wire = request?.model?.wire;
      if (!supportedWires.includes(wire)) {
        yield {
          role: EVENT.ERROR,
          content: {
            code: "WIRE_UNSUPPORTED",
            retryable: false,
            message: `${label} provider does not support wire "${wire ?? "(missing)"}".`,
          },
        };
        return;
      }

      try {
        if (!client) {
          throw new Error(`${label} provider is not configured.`);
        }

        const input = await expandAttachments(
          request.input,
          request.sentAttachments,
        );

        if (wire === OPENAI_RESPONSES_WIRE) {
          yield* requestResponses({ client, request, input });
          return;
        }

        yield* requestChat({
          client,
          request,
          input,
          preserveToolSignatures,
        });
      } catch (error) {
        const event = providerErrorEvent(error, {
          provider: id,
          secrets: secret ? [secret] : [],
        });
        if (event) yield event;
      }
    },

    continue(context) {
      return toolContinuation(context);
    },

    feed(context) {
      return toolContinuation(context);
    },

    dispose() {
      client = null;
      clientFingerprint = null;
      secret = null;
    },
  };

  return provider;
}
