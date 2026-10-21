// test/contracts/anthropic-adapter.test.js
//
// Anthropic Messages conformance: client lifecycle, thinking/tool block
// ordering, image/PDF tool results, SSE normalization, and safe errors. No
// network or real SDK.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ANTHROPIC_BASE_URL,
  createAnthropicProvider,
  toAnthropicMessages,
} from "../../src/llm/providers/anthropic/anthropic.js";
import { EVENT } from "../../src/shared/event-type.js";

function asyncIterable(items) {
  return (async function* stream() {
    yield* items;
  })();
}

function fakeAnthropic({ events = [], error = null } = {}) {
  const calls = [];
  const client = {
    messages: {
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

describe("Anthropic provider lifecycle", () => {
  it("reuses one client per credential/endpoint fingerprint and rotates explicitly", () => {
    const created = [];
    const provider = createAnthropicProvider({
      clientFactory(options) {
        created.push(options);
        return fakeAnthropic().client;
      },
    });

    provider.configure({ credentials: { apiKey: "key-1" } });
    provider.configure({ credentials: { apiKey: "key-1" } });
    assert.equal(created.length, 1);
    assert.deepEqual(created[0], {
      apiKey: "key-1",
      baseURL: ANTHROPIC_BASE_URL,
    });

    provider.configure({ credentials: { apiKey: "key-2" } });
    assert.equal(created.length, 2);

    provider.configure({
      credentials: { apiKey: "key-2" },
      endpoint: "https://anthropic.test/v1",
    });
    assert.equal(created.length, 3);
    assert.equal(created[2].baseURL, "https://anthropic.test/v1");

    provider.dispose();
    provider.configure({ credentials: { apiKey: "key-2" } });
    assert.equal(created.length, 4);
  });

  it("refuses an empty key and fails explicitly on the wrong wire", async () => {
    let made = 0;
    const provider = createAnthropicProvider({
      clientFactory() {
        made += 1;
        return fakeAnthropic().client;
      },
    });

    assert.throws(() => provider.configure({}), /requires an API key/);
    assert.equal(made, 0);

    const wrong = await collect(
      provider.request(request({ id: "claude-sonnet-5-5", wire: "openai-chat" })),
    );
    assert.equal(wrong.length, 1);
    assert.equal(wrong[0].role, EVENT.ERROR);
    assert.equal(wrong[0].content.code, "WIRE_UNSUPPORTED");
  });
});

describe("Anthropic Messages conversion", () => {
  it("keeps thinking, assistant text, and tool blocks in one assistant turn", () => {
    const messages = toAnthropicMessages([
      { role: EVENT.USER, content: { text: "question" } },
      {
        role: EVENT.REASONING_SIGNATURE,
        content: {
          kind: "anthropic-thinking",
          summary: "plan",
          signature: "sig-1",
        },
      },
      { role: EVENT.ASSISTANT, content: { text: "answer" } },
      {
        role: EVENT.TOOL_CALL,
        content: {
          call_id: "tool-1",
          name: "read",
          arguments: { path: "a.txt" },
        },
      },
      {
        role: EVENT.TOOL_RESULT,
        content: {
          call_id: "tool-1",
          name: "read",
          result: [
            { type: "text", text: "read ok" },
            { type: "image", data: "aGVsbG8=", mime_type: "image/png" },
            {
              type: "image",
              data: "cGRm",
              mime_type: "application/pdf",
            },
          ],
        },
      },
    ]);

    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, "user");
    assert.deepEqual(messages[1], {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan", signature: "sig-1" },
        { type: "text", text: "answer" },
        {
          type: "tool_use",
          id: "tool-1",
          name: "read",
          input: { path: "a.txt" },
        },
      ],
    });
    assert.equal(messages[2].role, "user");
    assert.deepEqual(messages[2].content[0], {
      type: "tool_result",
      tool_use_id: "tool-1",
      content: [
        { type: "text", text: "read ok" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
        },
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "cGRm",
          },
        },
      ],
    });
  });

  it("ignores signatures that belong to another provider", () => {
    const messages = toAnthropicMessages([
      {
        role: EVENT.REASONING_SIGNATURE,
        content: { kind: "google-thought", signature: "google-sig" },
      },
      { role: EVENT.ASSISTANT, content: { text: "safe" } },
    ]);
    assert.deepEqual(messages, [
      { role: "assistant", content: [{ type: "text", text: "safe" }] },
    ]);
  });

  it("maps grouped tool results into one user turn", () => {
    const messages = toAnthropicMessages([
      {
        role: EVENT.TOOL_RESULT,
        content: { call_id: "a", name: "read", result: "first" },
      },
      {
        role: EVENT.TOOL_RESULT,
        content: { call_id: "b", name: "read", result: "second" },
      },
    ]);

    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].content, [
      { type: "tool_result", tool_use_id: "a", content: "first" },
      { type: "tool_result", tool_use_id: "b", content: "second" },
    ]);
  });
});

describe("Anthropic Messages request and stream", () => {
  it("requests adaptive summarized thinking and normalizes the SSE stream", async () => {
    const fake = fakeAnthropic({
      events: [
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 1,
              cache_read_input_tokens: 3,
            },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "plan" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig-1" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Hello" },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "read",
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: {
            type: "input_json_delta",
            partial_json: '{"path":"a.txt"}',
          },
        },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ],
    });
    const provider = createAnthropicProvider({
      clientFactory: () => fake.client,
    });
    provider.configure({ credentials: { apiKey: "key" } });

    const events = await collect(
      provider.request(
        request(
          {
            id: "claude-sonnet-5-5",
            wire: "anthropic-messages",
            maxOutputTokens: 128000,
            capabilities: { reasoning: true },
          },
          {
            input: [{ role: EVENT.USER, content: { text: "question" } }],
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

    assert.deepEqual(
      events.map((event) => event.role),
      [
        EVENT.REASONING_SUMMARY,
        EVENT.REASONING_SIGNATURE,
        EVENT.ASSISTANT,
        EVENT.TOOL_CALL,
        EVENT.TOKEN,
      ],
    );
    assert.equal(events[0].content.text, "plan");
    assert.deepEqual(events[1].content, {
      kind: "anthropic-thinking",
      signature: "sig-1",
      summary: "plan",
    });
    assert.equal(events[2].content.text, "Hello");
    assert.deepEqual(events[3].content, {
      call_id: "tool-1",
      name: "read",
      arguments: { path: "a.txt" },
    });
    assert.deepEqual(events[4].content, {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cached_tokens: 3,
      reasoning_tokens: null,
    });

    const { body, options } = fake.calls[0];
    assert.equal(body.model, "claude-sonnet-5-5");
    assert.equal(body.max_tokens, 128000);
    assert.equal(body.stream, true);
    assert.equal(body.system, "system prompt");
    assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(body.tools, [
      {
        name: "read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ]);
    assert.equal(options.signal, undefined);
  });

  it("does not request thinking for non-reasoning models", async () => {
    const fake = fakeAnthropic({ events: [] });
    const provider = createAnthropicProvider({
      clientFactory: () => fake.client,
    });
    provider.configure({ credentials: { apiKey: "key" } });

    await collect(
      provider.request(
        request({
          id: "claude-haiku",
          wire: "anthropic-messages",
          maxOutputTokens: 8192,
          capabilities: { reasoning: false },
        }),
      ),
    );

    assert.equal("thinking" in fake.calls[0].body, false);
  });

  it("maps auth and network failures to safe terminal events", async () => {
    const secret = "custom_anthropic_credential_123";
    const auth = fakeAnthropic({
      error: {
        status: 401,
        message: `invalid key ${secret} (sk-ant-secret) at https://api.anthropic.test/v1`,
      },
    });
    const authProvider = createAnthropicProvider({
      clientFactory: () => auth.client,
    });
    authProvider.configure({ credentials: { apiKey: secret } });

    const authEvents = await collect(
      authProvider.request(
        request({ id: "claude-sonnet-5-5", wire: "anthropic-messages" }),
      ),
    );
    assert.equal(authEvents[0].content.code, "PROVIDER_AUTH_ERROR");
    assert.equal(authEvents[0].content.message.includes(secret), false);
    assert.equal(authEvents[0].content.message.includes("sk-ant-secret"), false);
    assert.equal(
      authEvents[0].content.message.includes("api.anthropic.test"),
      false,
    );

    const network = fakeAnthropic({
      error: { code: "ECONNRESET", message: "socket closed" },
    });
    const networkProvider = createAnthropicProvider({
      clientFactory: () => network.client,
    });
    networkProvider.configure({ credentials: { apiKey: "key" } });
    const networkEvents = await collect(
      networkProvider.request(
        request({ id: "claude-sonnet-5-5", wire: "anthropic-messages" }),
      ),
    );
    assert.equal(networkEvents[0].content.code, "PROVIDER_NETWORK_ERROR");
    assert.equal(networkEvents[0].content.retryable, true);
  });
});
