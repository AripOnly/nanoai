// test/contracts/openai-compatible.test.js
//
// Conformance for the shared OpenAI-compatible adapter: client lifecycle,
// Chat/Responses wire conversion, streaming normalization, slash model ids,
// explicit wire failures, and safe provider errors. No network or real SDK.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OPENAI_CHAT_WIRE,
  OPENAI_RESPONSES_WIRE,
  createOpenAICompatibleProvider,
} from "../../src/llm/providers/shared/openai-compatible.js";
import { toChatMessages } from "../../src/llm/providers/shared/openai-chat.js";
import {
  OPENAI_REASONING_KIND,
  parseReasoningItem,
  serializeReasoningItem,
} from "../../src/llm/providers/shared/values.js";
import { toResponsesInput } from "../../src/llm/providers/shared/openai-responses.js";
import {
  OPENAI_BASE_URL,
  createOpenAIProvider,
} from "../../src/llm/providers/openai/openai.js";
import {
  OPENROUTER_BASE_URL,
  createOpenRouterProvider,
} from "../../src/llm/providers/openrouter/openrouter.js";
import {
  OPENCODE_ZEN_BASE_URL,
  createOpenCodeZenProvider,
} from "../../src/llm/providers/opencode-zen/opencode-zen.js";
import { EVENT } from "../../src/shared/event-type.js";

function asyncIterable(items) {
  return (async function* stream() {
    yield* items;
  })();
}

function fakeClient({ chat = [], responses = [], chatError = null, responsesError = null } = {}) {
  const calls = { chat: [], responses: [] };
  const client = {
    chat: {
      completions: {
        async create(body, options) {
          calls.chat.push({ body, options });
          if (chatError) throw chatError;
          return asyncIterable(chat);
        },
      },
    },
    responses: {
      async create(body, options) {
        calls.responses.push({ body, options });
        if (responsesError) throw responsesError;
        return asyncIterable(responses);
      },
    },
  };
  return { client, calls };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
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

function configure(provider, client, apiKey = "test-key") {
  provider.configure({
    credentials: { apiKey },
    endpoint: null,
  });
  return client;
}

describe("OpenAI-compatible provider factory", () => {
  it("reuses one client per credential/endpoint fingerprint and rotates explicitly", () => {
    const created = [];
    const provider = createOpenAICompatibleProvider({
      id: "test",
      label: "Test",
      defaultBaseURL: "https://default.test/v1",
      defaultHeaders: { "X-Test": "1" },
      clientFactory(options) {
        created.push(options);
        return fakeClient().client;
      },
    });

    provider.configure({ credentials: { apiKey: "key-1" } });
    provider.configure({ credentials: { apiKey: "key-1" } });
    assert.equal(created.length, 1);
    assert.deepEqual(created[0], {
      apiKey: "key-1",
      baseURL: "https://default.test/v1",
      defaultHeaders: { "X-Test": "1" },
    });

    provider.configure({ credentials: { apiKey: "key-2" } });
    assert.equal(created.length, 2, "credential rotation recreates the client");

    provider.configure({
      credentials: { apiKey: "key-2" },
      endpoint: "https://custom.test/v1",
    });
    assert.equal(created.length, 3, "endpoint change recreates the client");
    assert.equal(created[2].baseURL, "https://custom.test/v1");

    provider.dispose();
    provider.configure({ credentials: { apiKey: "key-2" } });
    assert.equal(created.length, 4, "dispose clears the cached client");
    assert.equal(created[3].baseURL, "https://default.test/v1");
  });

  it("refuses an empty key before creating a client", () => {
    let made = 0;
    const provider = createOpenAICompatibleProvider({
      id: "test",
      label: "Test",
      clientFactory() {
        made += 1;
        return fakeClient().client;
      },
    });

    assert.throws(() => provider.configure({}), /requires an API key/);
    assert.throws(
      () => provider.configure({ credentials: { apiKey: "   " } }),
      /requires an API key/,
    );
    assert.equal(made, 0);
  });

  it("fails explicitly when unconfigured or used with the wrong wire", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "test",
      label: "Test",
      clientFactory: () => fakeClient().client,
    });

    const wrongWire = await collect(
      provider.request(request({ id: "m", wire: "google-interactions" })),
    );
    assert.equal(wrongWire.length, 1);
    assert.equal(wrongWire[0].role, EVENT.ERROR);
    assert.equal(wrongWire[0].content.code, "WIRE_UNSUPPORTED");
    assert.equal(wrongWire[0].content.retryable, false);

    const unconfigured = await collect(
      provider.request(request({ id: "m", wire: OPENAI_CHAT_WIRE })),
    );
    assert.equal(unconfigured.length, 1);
    assert.equal(unconfigured[0].role, EVENT.ERROR);
    assert.match(unconfigured[0].content.message, /not configured/);
  });

  it("exposes the three OpenAI-compatible provider identities and endpoints", () => {
    assert.equal(createOpenAIProvider().id, "openai");
    assert.equal(OPENAI_BASE_URL, "https://api.openai.com/v1");
    assert.deepEqual(createOpenAIProvider().supportedWires, [
      OPENAI_RESPONSES_WIRE,
      OPENAI_CHAT_WIRE,
    ]);

    const openrouter = createOpenRouterProvider();
    assert.equal(openrouter.id, "openrouter");
    assert.equal(OPENROUTER_BASE_URL, "https://openrouter.ai/api/v1");
    assert.deepEqual(openrouter.supportedWires, [
      OPENAI_RESPONSES_WIRE,
      OPENAI_CHAT_WIRE,
    ]);

    const zen = createOpenCodeZenProvider();
    assert.equal(zen.id, "opencode-zen");
    assert.equal(
      OPENCODE_ZEN_BASE_URL,
      "https://opencode.ai/inference/openai/v1",
    );
    assert.deepEqual(zen.supportedWires, [
      OPENAI_RESPONSES_WIRE,
      OPENAI_CHAT_WIRE,
    ]);
  });
});

describe("OpenAI Chat wire", () => {
  it("converts a slash model id and the neutral request body", async () => {
    const fake = fakeClient({
      chat: [
        {
          choices: [{ delta: { content: "ok" } }],
        },
      ],
    });
    const provider = createOpenAICompatibleProvider({
      id: "test",
      clientFactory: () => fake.client,
    });
    configure(provider, fake);

    const events = await collect(
      provider.request(
        request(
          {
            id: "deepseek/deepseek-v4.1-flash",
            wire: OPENAI_CHAT_WIRE,
            capabilities: { reasoning: true },
          },
          {
            input: [{ role: EVENT.USER, content: { text: "hi" } }],
            tools: [
              {
                type: "function",
                name: "read",
                description: "Read a file",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                },
              },
            ],
          },
        ),
      ),
    );

    assert.deepEqual(events.map((event) => event.role), [EVENT.ASSISTANT]);
    assert.equal(events[0].content.text, "ok");

    const { body, options } = fake.calls.chat[0];
    assert.equal(body.model, "deepseek/deepseek-v4.1-flash");
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal("store" in body, false);
    assert.deepEqual(body.messages, [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hi" },
    ]);
    assert.deepEqual(body.tools, [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
    ]);
    assert.equal(options.signal, undefined);
  });

  it("normalizes text, reasoning, accumulated tool calls, and usage", async () => {
    const fake = fakeClient({
      chat: [
        { choices: [{ delta: { content: "Hel" } }] },
        {
          choices: [
            {
              delta: {
                content: "lo",
                reasoning_content: "thinking",
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "read", arguments: '{"path":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '"a.txt"}' } },
                ],
              },
            },
          ],
        },
        {
          choices: [],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
            prompt_tokens_details: { cached_tokens: 2 },
            completion_tokens_details: { reasoning_tokens: 1 },
          },
        },
      ],
    });
    const provider = createOpenAICompatibleProvider({
      id: "test",
      clientFactory: () => fake.client,
    });
    configure(provider, fake);

    const events = await collect(
      provider.request(
        request({
          id: "model",
          wire: OPENAI_CHAT_WIRE,
          capabilities: { reasoning: true },
        }),
      ),
    );

    assert.deepEqual(
      events.map((event) => event.role),
      [
        EVENT.ASSISTANT,
        EVENT.ASSISTANT,
        EVENT.REASONING_SUMMARY,
        EVENT.TOOL_CALL,
        EVENT.TOKEN,
      ],
    );
    assert.equal(events[3].content.call_id, "call-1");
    assert.equal(events[3].content.name, "read");
    assert.deepEqual(events[3].content.arguments, { path: "a.txt" });
    assert.deepEqual(events[4].content, {
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
      cached_tokens: 2,
      reasoning_tokens: 1,
    });
  });

  it("keeps tool-result images in a following user message", () => {
    const messages = toChatMessages([
      {
        role: EVENT.ASSISTANT,
        content: { text: "checking" },
      },
      {
        role: EVENT.TOOL_CALL,
        content: {
          call_id: "call-1",
          name: "read",
          arguments: { path: "image.png" },
          signature: "tool-sig",
        },
      },
      {
        role: EVENT.TOOL_RESULT,
        content: {
          call_id: "call-1",
          name: "read",
          result: [
            { type: "text", text: "read ok" },
            { type: "image", data: "aGVsbG8=", mime_type: "image/png" },
          ],
        },
      },
    ], "", { preserveToolSignatures: true });

    assert.deepEqual(messages[0], {
      role: "assistant",
      content: "checking",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "read",
            arguments: '{"path":"image.png"}',
          },
          extra_content: {
            google: { thought_signature: "tool-sig" },
          },
        },
      ],
    });
    assert.deepEqual(messages[1], {
      role: "tool",
      tool_call_id: "call-1",
      content: "read ok",
    });
    assert.deepEqual(messages[2], {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,aGVsbG8=" },
        },
      ],
    });
  });
});

describe("OpenAI Responses wire", () => {
  it("always sends store:false and round-trips reasoning items before assistant text", async () => {
    const signature = serializeReasoningItem({
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "plan" }],
      encrypted_content: "encrypted-state",
    });
    assert.ok(signature);

    const fake = fakeClient({
      responses: [
        {
          type: "response.completed",
          response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
        },
      ],
    });
    const provider = createOpenAICompatibleProvider({
      id: "test",
      clientFactory: () => fake.client,
    });
    configure(provider, fake);

    const events = await collect(
      provider.request(
        request(
          {
            id: "gpt-5.5",
            wire: OPENAI_RESPONSES_WIRE,
            capabilities: { reasoning: true },
          },
          {
            input: [
              { role: EVENT.USER, content: { text: "question" } },
              { role: EVENT.REASONING_SIGNATURE, content: { signature } },
              { role: EVENT.ASSISTANT, content: { text: "answer" } },
              {
                role: EVENT.TOOL_CALL,
                content: {
                  call_id: "call-1",
                  name: "read",
                  arguments: { path: "a.txt" },
                },
              },
              {
                role: EVENT.TOOL_RESULT,
                content: {
                  call_id: "call-1",
                  name: "read",
                  result: "ok",
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

    assert.deepEqual(events.map((event) => event.role), [EVENT.TOKEN]);
    const { body, options } = fake.calls.responses[0];
    assert.equal(body.model, "gpt-5.5");
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.instructions, "system prompt");
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(body.reasoning, { summary: "auto" });
    assert.equal(body.input[1].type, "reasoning");
    assert.equal(body.input[1].encrypted_content, "encrypted-state");
    assert.deepEqual(body.input[2], { role: "assistant", content: "answer" });
    assert.deepEqual(body.input[3], {
      type: "function_call",
      call_id: "call-1",
      name: "read",
      arguments: '{"path":"a.txt"}',
    });
    assert.deepEqual(body.input[4], {
      type: "function_call_output",
      call_id: "call-1",
      output: "ok",
    });
    assert.deepEqual(body.tools, [
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
    ]);
    assert.equal(options.signal, undefined);
  });

  it("omits reasoning parameters for non-reasoning models", async () => {
    const fake = fakeClient({
      responses: [
        {
          type: "response.completed",
          response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        },
      ],
    });
    const provider = createOpenAICompatibleProvider({
      id: "test",
      clientFactory: () => fake.client,
    });
    configure(provider, fake);

    await collect(
      provider.request(
        request({
          id: "gpt-4.1",
          wire: OPENAI_RESPONSES_WIRE,
          capabilities: { reasoning: false },
        }),
      ),
    );

    const body = fake.calls.responses[0].body;
    assert.equal(body.store, false);
    assert.equal("include" in body, false);
    assert.equal("reasoning" in body, false);
  });

  it("normalizes summary, encrypted signature, text, tool call, and usage", async () => {
    const fake = fakeClient({
      responses: [
        {
          type: "response.reasoning_summary_text.delta",
          delta: "thinking",
        },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "thinking" }],
            encrypted_content: "encrypted-state",
          },
        },
        {
          type: "response.output_text.delta",
          delta: "Hello",
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call-1",
            name: "read",
            arguments: '{"path":"a.txt"}',
          },
        },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 8,
              output_tokens: 3,
              total_tokens: 11,
              input_tokens_details: { cached_tokens: 4 },
              output_tokens_details: { reasoning_tokens: 2 },
            },
          },
        },
      ],
    });
    const provider = createOpenAICompatibleProvider({
      id: "test",
      clientFactory: () => fake.client,
    });
    configure(provider, fake);

    const events = await collect(
      provider.request(
        request({
          id: "gpt-5.5",
          wire: OPENAI_RESPONSES_WIRE,
          capabilities: { reasoning: true },
        }),
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
    assert.equal(events[0].content.text, "thinking");
    assert.equal(events[1].content.kind, OPENAI_REASONING_KIND);
    assert.equal(events[1].content.summary, "thinking");
    const item = parseReasoningItem(events[1].content.signature);
    assert.equal(item.id, "rs_1");
    assert.equal(item.encrypted_content, "encrypted-state");
    assert.equal(events[2].content.text, "Hello");
    assert.deepEqual(events[3].content.arguments, { path: "a.txt" });
    assert.deepEqual(events[4].content, {
      input_tokens: 8,
      output_tokens: 3,
      total_tokens: 11,
      cached_tokens: 4,
      reasoning_tokens: 2,
    });
  });

  it("marks non-image tool attachments as unsupported text", () => {
    const input = toResponsesInput([
      {
        role: EVENT.TOOL_RESULT,
        content: {
          call_id: "call-1",
          name: "read",
          result: [
            { type: "text", text: "pdf loaded" },
            {
              type: "image",
              data: "cGRm",
              mime_type: "application/pdf",
            },
          ],
        },
      },
    ]);

    assert.deepEqual(input[0].output, [
      { type: "input_text", text: "pdf loaded" },
      { type: "input_text", text: "(Unsupported attachment type: application/pdf)" },
    ]);
  });

  it("maps SDK failures to the shared safe taxonomy", async () => {
    const secret = "custom_gateway_credential_42";
    const fake = fakeClient({
      responsesError: {
        status: 401,
        message: `bad key ${secret} (sk-live-secret) at https://api.example.test/v1`,
      },
    });
    const provider = createOpenAICompatibleProvider({
      id: "test",
      clientFactory: () => fake.client,
    });
    configure(provider, fake, secret);

    const events = await collect(
      provider.request(
        request({
          id: "gpt-5.5",
          wire: OPENAI_RESPONSES_WIRE,
          capabilities: { reasoning: false },
        }),
      ),
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].role, EVENT.ERROR);
    assert.equal(events[0].content.code, "PROVIDER_AUTH_ERROR");
    assert.equal(events[0].content.retryable, false);
    assert.equal(events[0].content.message.includes(secret), false);
    assert.equal(events[0].content.message.includes("sk-live-secret"), false);
    assert.equal(events[0].content.message.includes("api.example.test"), false);
  });
});
