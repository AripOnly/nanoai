// test/contracts/google-adapter.test.js
//
// Google Interactions conformance: stateless requests (store:false), one
// SDK client per fingerprint, thought signatures as dedicated thought steps,
// and safe terminal errors. No network or real SDK.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGoogleProvider } from "../../src/llm/providers/google/google.js";
import { EVENT } from "../../src/shared/event-type.js";

function asyncIterable(items) {
  return (async function* stream() {
    yield* items;
  })();
}

function fakeGoogle({ events = [], error = null } = {}) {
  const calls = [];
  const client = {
    interactions: {
      async create(body, options) {
        calls.push({ body, options });
        if (error) throw error;
        return asyncIterable(events);
      },
    },
  };
  return { client, calls };
}

async function collect(stream) {
  const all = [];
  for await (const event of stream) all.push(event);
  return all;
}

function request(model, overrides = {}) {
  return {
    model,
    instruction: "system prompt",
    input: [],
    tools: [],
    sentAttachments: new Set(),
    signal: undefined,
    ...overrides,
  };
}

describe("Google provider lifecycle", () => {
  it("reuses one client per credential/endpoint fingerprint and rotates explicitly", () => {
    const created = [];
    const provider = createGoogleProvider({
      clientFactory(options) {
        created.push(options);
        return fakeGoogle().client;
      },
    });

    provider.configure({ credentials: { apiKey: "key-1" } });
    provider.configure({ credentials: { apiKey: "key-1" } });
    assert.equal(created.length, 1);
    assert.deepEqual(created[0], { apiKey: "key-1" });

    provider.configure({ credentials: { apiKey: "key-2" } });
    assert.equal(created.length, 2);

    provider.configure({
      credentials: { apiKey: "key-2" },
      endpoint: "https://google.test/v1",
    });
    assert.equal(created.length, 3);
    assert.deepEqual(created[2].httpOptions, {
      baseUrl: "https://google.test/v1",
    });

    provider.dispose();
    provider.configure({ credentials: { apiKey: "key-2" } });
    assert.equal(created.length, 4);
  });

  it("refuses an empty key and an unsupported wire explicitly", async () => {
    let made = 0;
    const provider = createGoogleProvider({
      clientFactory() {
        made += 1;
        return fakeGoogle().client;
      },
    });

    assert.throws(() => provider.configure({}), /requires an API key/);
    assert.equal(made, 0);

    const wrong = await collect(
      provider.request(request({ id: "gemini-test", wire: "openai-chat" })),
    );
    assert.equal(wrong.length, 1);
    assert.equal(wrong[0].role, EVENT.ERROR);
    assert.equal(wrong[0].content.code, "WIRE_UNSUPPORTED");
  });
});

describe("Google Interactions request", () => {
  it("sends store:false and separates thought steps from tool parts", async () => {
    const fake = fakeGoogle({
      events: [
        {
          event_type: "interaction.completed",
          interaction: {
            usage: {
              total_input_tokens: 5,
              total_output_tokens: 2,
              total_tokens: 7,
            },
          },
        },
      ],
    });
    const provider = createGoogleProvider({
      clientFactory: () => fake.client,
    });
    provider.configure({ credentials: { apiKey: "key" } });

    await collect(
      provider.request(
        request(
          {
            id: "gemini-3.1-flash-lite",
            wire: "google-interactions",
          },
          {
            input: [
              { role: EVENT.USER, content: { text: "question" } },
              {
                role: EVENT.REASONING_SIGNATURE,
                content: {
                  kind: "google-thought",
                  summary: "plan",
                  signature: "sig-1",
                },
              },
              {
                role: EVENT.REASONING_SIGNATURE,
                content: {
                  kind: "anthropic-thinking",
                  summary: "foreign",
                  signature: "other-sig",
                },
              },
              {
                role: EVENT.REASONING_SIGNATURE,
                content: {
                  kind: "nanoai.openai.responses.reasoning",
                  signature: "other-openai-sig",
                },
              },
              { role: EVENT.ASSISTANT, content: { text: "answer" } },
              {
                role: EVENT.TOOL_CALL,
                content: {
                  call_id: "call-1",
                  name: "read",
                  arguments: { path: "a.txt" },
                  signature: "must-not-attach",
                },
              },
              {
                role: EVENT.TOOL_RESULT,
                content: {
                  call_id: "call-1",
                  name: "read",
                  result: "ok",
                  signature: "must-not-attach",
                },
              },
            ],
            tools: [
              {
                type: "function",
                name: "read",
                description: "Read a file",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
        ),
      ),
    );

    const { body, options } = fake.calls[0];
    assert.equal(body.model, "gemini-3.1-flash-lite");
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.system_instruction, "system prompt");
    assert.equal(body.generation_config.temperature, 1.0);
    assert.deepEqual(body.tools, [
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
    ]);
    assert.equal(options.fetchOptions.signal, undefined);

    assert.deepEqual(body.input[0], {
      type: "user_input",
      content: [{ type: "text", text: "question" }],
    });
    assert.deepEqual(body.input[1], {
      type: "thought",
      signature: "sig-1",
      summary: [{ type: "text", text: "plan" }],
    });
    assert.deepEqual(body.input[2], {
      type: "model_output",
      content: [{ type: "text", text: "answer" }],
    });
    assert.deepEqual(body.input[3], {
      type: "function_call",
      id: "call-1",
      name: "read",
      arguments: { path: "a.txt" },
    });
    assert.deepEqual(body.input[4], {
      type: "function_result",
      call_id: "call-1",
      name: "read",
      result: "ok",
    });
    assert.equal(body.input.length, 5, "foreign signatures are ignored");
    assert.equal(JSON.stringify(body).includes("must-not-attach"), false);
  });

  it("normalizes a thought step into one summary and one signature event", async () => {
    const fake = fakeGoogle({
      events: [
        {
          event_type: "step.start",
          step: {
            type: "thought",
            summary: [{ type: "text", text: "I should check." }],
          },
        },
        {
          event_type: "step.delta",
          delta: { type: "thought_signature", signature: "sig-1" },
        },
        { event_type: "step.stop", step: { type: "thought" } },
        {
          event_type: "step.start",
          step: { type: "function_call", id: "call-1", name: "read" },
        },
        {
          event_type: "step.delta",
          delta: { type: "arguments_delta", arguments: '{"path":"a.txt"}' },
        },
        { event_type: "step.stop", step: { type: "function_call" } },
        {
          event_type: "interaction.completed",
          interaction: {
            usage: {
              total_input_tokens: 8,
              total_output_tokens: 4,
              total_tokens: 12,
            },
          },
        },
      ],
    });
    const provider = createGoogleProvider({
      clientFactory: () => fake.client,
    });
    provider.configure({ credentials: { apiKey: "key" } });

    const events = await collect(
      provider.request(
        request({ id: "gemini-3.1-flash-lite", wire: "google-interactions" }),
      ),
    );

    assert.deepEqual(
      events.map((event) => event.role),
      [
        EVENT.REASONING_SUMMARY,
        EVENT.REASONING_SIGNATURE,
        EVENT.TOOL_CALL,
        EVENT.TOKEN,
      ],
    );
    assert.equal(events[0].content.text, "I should check.");
    assert.deepEqual(events[1].content, {
      kind: "google-thought",
      signature: "sig-1",
      summary: "I should check.",
    });
    assert.deepEqual(events[2].content, {
      call_id: "call-1",
      name: "read",
      arguments: { path: "a.txt" },
    });
    assert.equal("signature" in events[2].content, false);
    assert.deepEqual(events[3].content, {
      input_tokens: 8,
      output_tokens: 4,
      total_tokens: 12,
    });
  });

  it("maps auth and network failures to safe terminal events", async () => {
    const secret = "custom_google_credential_123";
    const auth = fakeGoogle({
      error: {
        status: 401,
        message: `API key not valid: ${secret} AIza123456789012345678901234567890`,
      },
    });
    const authProvider = createGoogleProvider({
      clientFactory: () => auth.client,
    });
    authProvider.configure({ credentials: { apiKey: secret } });

    const authEvents = await collect(
      authProvider.request(
        request({ id: "gemini-3.1-flash-lite", wire: "google-interactions" }),
      ),
    );
    assert.equal(authEvents[0].content.code, "PROVIDER_AUTH_ERROR");
    assert.equal(authEvents[0].content.message.includes(secret), false);
    assert.equal(
      authEvents[0].content.message.includes(
        "AIza123456789012345678901234567890",
      ),
      false,
    );

    const network = fakeGoogle({
      error: { code: "ETIMEDOUT", message: "connection timed out" },
    });
    const networkProvider = createGoogleProvider({
      clientFactory: () => network.client,
    });
    networkProvider.configure({ credentials: { apiKey: "key" } });
    const networkEvents = await collect(
      networkProvider.request(
        request({ id: "gemini-3.1-flash-lite", wire: "google-interactions" }),
      ),
    );
    assert.equal(networkEvents[0].content.code, "PROVIDER_NETWORK_ERROR");
    assert.equal(networkEvents[0].content.retryable, true);
  });

  it("classifies auth errors from a decoded JSON body array", async () => {
    const secret = "body_array_google_credential_123";
    const auth = fakeGoogle({
      error: {
        status: 400,
        message: '400 API error occurred: {"httpMeta":{}}',
        body: [
          {
            error: {
              code: 400,
              message: `API key not valid. Please pass a valid API key. ${secret}`,
            },
          },
        ],
      },
    });
    const provider = createGoogleProvider({
      clientFactory: () => auth.client,
    });
    provider.configure({ credentials: { apiKey: secret } });

    const events = await collect(
      provider.request(
        request({ id: "gemini-3.1-flash-lite", wire: "google-interactions" }),
      ),
    );

    assert.equal(events[0].content.code, "PROVIDER_AUTH_ERROR");
    assert.match(events[0].content.message, /API key not valid/);
    assert.equal(events[0].content.message.includes(secret), false);
  });
});
