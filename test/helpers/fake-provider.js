// test/helpers/fake-provider.js
//
// Scriptable in-process provider for tests. No network, no SDK. Each call to
// request() consumes the next scripted turn; when the script runs out, the
// last turn is reused. Every lifecycle call is recorded so tests can assert on
// the exact request (model, input, tools, signal) and on feed/dispose calls.
//
// The Revisi 2 provider contract is
// { configure, request, continue, dispose }. feed() remains as a legacy alias
// so characterization tests can keep exercising the old call shape.

import { EVENT } from "#src/shared/event-type.js";

export const FAKE_MODEL = Object.freeze({
  provider: "fake",
  id: "fake-model",
  name: "Fake Model",
  wire: "fake-wire",
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  capabilities: Object.freeze({
    streaming: true,
    toolCalling: true,
    parallelToolCalls: true,
    reasoning: true,
    vision: false,
    pdf: false,
    audio: false,
    structuredOutput: true,
  }),
  status: "active",
});

export const FAKE_MODELS = Object.freeze([FAKE_MODEL]);

/** One assistant text part. */
export function assistant(text) {
  return { role: EVENT.ASSISTANT, content: { text } };
}

/** One reasoning summary part (shown to the user, not the model). */
export function reasoning(text) {
  return { role: EVENT.REASONING_SUMMARY, content: { text } };
}

/** Opaque provider reasoning token that must round-trip through feed(). */
export function reasoningSignature(signature) {
  return { role: EVENT.REASONING_SIGNATURE, content: { signature } };
}

/** One tool call requested by the model. */
export function toolCall({ call_id = "call_1", name, arguments: args = {}, signature } = {}) {
  return {
    role: EVENT.TOOL_CALL,
    content: {
      call_id,
      name,
      arguments: args,
      ...(signature != null ? { signature } : {}),
    },
  };
}

/** Usage event. Missing fields stay null instead of pretending to be zero. */
export function usage({
  input_tokens = 0,
  output_tokens = 0,
  total_tokens = input_tokens + output_tokens,
  cached_tokens = null,
  reasoning_tokens = null,
} = {}) {
  return {
    role: EVENT.TOKEN,
    content: { input_tokens, output_tokens, total_tokens, cached_tokens, reasoning_tokens },
  };
}

/** A terminal provider error event. */
export function errorEvent(message) {
  return { role: EVENT.ERROR, content: { message } };
}

/** Convenience: a complete text-only turn. */
export function textTurn(text, usageOptions) {
  return [assistant(text), usage(usageOptions)];
}

/** Convenience: a turn that asks for one tool call. */
export function toolTurn({ call_id, name, arguments: args, signature } = {}) {
  return [
    toolCall({ call_id, name, arguments: args, signature }),
    usage({ input_tokens: 10, output_tokens: 2 }),
  ];
}

/**
 * Build a fake provider.
 *
 * @param {object} [options]
 * @param {string} [options.id] provider id (default "fake")
 * @param {string[]} [options.supportedWires] wires the adapter claims
 * @param {Array<Array<object|Function>>} [options.turns] scripted turns
 * @returns {object} provider with the Revisi 2 contract
 */
export function createFakeProvider({
  id = "fake",
  supportedWires = ["fake-wire"],
  turns = [textTurn("fake response")],
} = {}) {
  if (!Array.isArray(turns) || turns.length === 0) {
    throw new TypeError("createFakeProvider: turns must be a non-empty array");
  }

  const calls = {
    configure: [],
    request: [],
    feed: [],
    continue: [],
    dispose: 0,
  };

  let nextTurn = 0;
  let config = null;

  const provider = {
    id,
    supportedWires: Object.freeze([...supportedWires]),
    calls,
    get config() {
      return config;
    },

    /** Revisi 2: resolver-supplied credentials/endpoint snapshot. */
    configure(snapshot) {
      config = snapshot;
      calls.configure.push(snapshot);
      return provider;
    },

    async *request(request) {
      calls.request.push(request);
      const script = turns[Math.min(nextTurn, turns.length - 1)];
      nextTurn += 1;

      for (const item of script) {
        if (request?.signal?.aborted) {
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          throw error;
        }
        const event = typeof item === "function" ? await item(request) : item;
        if (event == null) continue;
        if (Array.isArray(event)) {
          yield* event;
        } else {
          yield event;
        }
      }
    },

    /** Current contract: history parts the adapter needs to keep. */
    feed(context) {
      calls.feed.push(context);
      return [];
    },

    /** Revisi 2 name for the same operation. */
    continue(context) {
      calls.continue.push(context);
      return [];
    },

    /** Revisi 2: release provider clients. */
    dispose() {
      calls.dispose += 1;
    },
  };

  return provider;
}
