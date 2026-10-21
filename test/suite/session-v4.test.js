// test/suite/session-v4.test.js
//
// Fase 3 contract: one session per channel identity, idempotent client message
// ids, per-turn usage, a durable per-session model override, and backwards
// conversation pagination. Runtime tests use the real SQLite door with a
// scripted provider, so persistence and replay are proven together.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as sessionDoor from "../../src/session/index.js";
import { runTurn } from "../../src/runtime/turn.js";
import { EVENT } from "../../src/shared/event-type.js";
import {
  FAKE_MODEL,
  createFakeProvider,
  textTurn,
  toolCall,
  usage,
} from "../helpers/fake-provider.js";

const IDS = new Set();

function createSession(options) {
  const row = sessionDoor.createSession(options);
  IDS.add(row.id);
  return row;
}

after(() => {
  for (const id of IDS) {
    try {
      sessionDoor.deleteSession(id);
    } catch {
      // Cleanup must never fail the suite.
    }
  }
});

function depsFor(provider, { model = "fake/fake-model", seen = [] } = {}) {
  return {
    session: sessionDoor,
    getConfig: () => ({
      model,
      username: "tester",
      compaction: { ratio: 85, keep_turn: 2 },
    }),
    getCatalog: () => null,
    resolveModel: async ({ modelRef }) => {
      seen.push(modelRef);
      return {
        providerId: "fake",
        modelId: "fake-model",
        modelRef,
        adapter: provider,
        model: FAKE_MODEL,
        limits: {
          contextWindow: FAKE_MODEL.contextWindow,
          maxOutputTokens: FAKE_MODEL.maxOutputTokens,
        },
        capabilities: FAKE_MODEL.capabilities,
      };
    },
    logger: { error() {}, warn() {} },
  };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("session v4 channel identity", () => {
  it("maps channel + external_ref to exactly one session", () => {
    const first = sessionDoor.resolveSession({
      channel: "telegram",
      externalRef: "chat-42",
      model: "fake/fake-model",
    });
    IDS.add(first.id);
    const second = sessionDoor.resolveSession({
      channel: "telegram",
      externalRef: "chat-42",
      model: "ignored-after-create",
    });
    IDS.add(second.id);

    assert.equal(first.id, second.id);
    assert.equal(first.kind, "chat");
    assert.equal(first.channel, "telegram");
    assert.equal(first.external_ref, "chat-42");
    assert.equal(first.model, "fake/fake-model");
    assert.equal(second.model, "fake/fake-model");

    const other = sessionDoor.resolveSession({
      channel: "slack",
      externalRef: "chat-42",
    });
    IDS.add(other.id);
    assert.notEqual(other.id, first.id);

    assert.throws(
      () => sessionDoor.resolveSession({ channel: "telegram" }),
      /external_ref/,
    );
  });

  it("does not create or mutate a session for rejected requests", async () => {
    const count = () =>
      sessionDoor
        .listSessions()
        .filter(
          (row) =>
            row.channel === "telegram" && row.external_ref === "never-created",
        ).length;

    const rejected = await collect(
      runTurn({
        agentName: "not-a-real-agent",
        prompt: "nope",
        channel: "telegram",
        externalRef: "never-created",
        deps: depsFor(createFakeProvider({ turns: [textTurn("unused")] })),
      }),
    );
    assert.equal(rejected[0].role, EVENT.ERROR);
    assert.match(rejected[0].content.message, /Unknown agent/);
    assert.equal(count(), 0);

    const controller = new AbortController();
    controller.abort();
    const aborted = await collect(
      runTurn({
        agentName: "nano",
        prompt: "nope",
        channel: "telegram",
        externalRef: "never-created",
        signal: controller.signal,
        deps: depsFor(createFakeProvider({ turns: [textTurn("unused")] })),
      }),
    );
    assert.deepEqual(aborted, []);
    assert.equal(count(), 0);

    const busy = createSession({
      prompt: "busy",
      model: "fake/original-model",
    });
    sessionDoor.beginTurn(busy.id, "holding the lock");
    try {
      await assert.rejects(
        collect(
          runTurn({
            name: "nano",
            prompt: "blocked",
            session_id: busy.id,
            model: "fake/should-not-stick",
            deps: depsFor(createFakeProvider({ turns: [textTurn("unused")] })),
          }),
        ),
        (error) => error instanceof sessionDoor.SessionBusyError,
      );
      assert.equal(
        sessionDoor.getSessionInfo(busy.id).model,
        "fake/original-model",
      );
    } finally {
      sessionDoor.commitTurn(busy.id);
    }

    const badModel = createSession({
      prompt: "bad model",
      model: "fake/original-model",
    });
    const failingDeps = depsFor(createFakeProvider({ turns: [textTurn("no")] }));
    failingDeps.resolveModel = async () => {
      throw new Error("unknown model");
    };
    const failed = await collect(
      runTurn({
        name: "nano",
        prompt: "use a broken model",
        session_id: badModel.id,
        model: "fake/broken-model",
        deps: failingDeps,
      }),
    );
    assert.equal(failed.at(-1).role, EVENT.ERROR);
    assert.equal(
      sessionDoor.getSessionInfo(badModel.id).model,
      "fake/original-model",
      "a failed resolver must not persist the override",
    );

    const channelFailure = await collect(
      runTurn({
        name: "nano",
        prompt: "broken channel model",
        channel: "telegram",
        externalRef: "never-poisoned",
        model: "fake/broken-model",
        deps: failingDeps,
      }),
    );
    assert.equal(channelFailure.at(-1).role, EVENT.ERROR);
    const mapped = sessionDoor.resolveSession({
      channel: "telegram",
      externalRef: "never-poisoned",
    });
    IDS.add(mapped.id);
    assert.equal(
      mapped.model,
      null,
      "a failed first channel request must not pin the session model",
    );
  });

  it("creates and then reuses a channel session from the runtime", async () => {
    const provider = createFakeProvider({
      turns: [textTurn("channel reply", { input_tokens: 3, output_tokens: 2 })],
    });
    const seen = [];
    const events = await collect(
      runTurn({
        agentName: "nano",
        prompt: "hello from telegram",
        channel: "telegram",
        externalRef: "runtime-chat-7",
        clientMessageId: "msg-1",
        deps: depsFor(provider, { seen }),
      }),
    );

    const start = events[0];
    assert.equal(start.role, EVENT.TURN_START);
    assert.equal(start.content.replayed, false);
    const sessionId = start.content.session_id;
    assert.equal(typeof sessionId, "string");
    IDS.add(sessionId);

    assert.deepEqual(
      events.map((event) => event.role),
      [EVENT.TURN_START, EVENT.ASSISTANT, EVENT.TOKEN],
    );
    assert.equal(events[1].content.text, "channel reply");
    assert.equal(seen[0], "fake/fake-model");

    const mapped = sessionDoor.resolveSession({
      channel: "telegram",
      externalRef: "runtime-chat-7",
    });
    IDS.add(mapped.id);
    assert.equal(mapped.id, sessionId);

    const turns = sessionDoor.listTurns(sessionId);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].client_message_id, "msg-1");
    assert.equal(turns[0].provider, "fake");
    assert.equal(turns[0].model, "fake-model");
    assert.deepEqual(turns[0].usage, {
      requests: 1,
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      cached_tokens: null,
      reasoning_tokens: null,
    });
  });
});

describe("turn idempotency and usage", () => {
  it("replays a completed client_message_id without calling the provider twice", async () => {
    const provider = createFakeProvider({
      turns: [
        textTurn("only once", { input_tokens: 4, output_tokens: 1 }),
        textTurn("must not run"),
      ],
    });
    const row = createSession({ prompt: "retry me" });
    const options = {
      name: "nano",
      prompt: "retry me",
      session_id: row.id,
      client_message_id: "client-1",
      model: "fake/first-model",
      deps: depsFor(provider),
    };

    const first = await collect(runTurn(options));
    assert.equal(provider.calls.request.length, 1);
    assert.equal(first.at(-2).content.text, "only once");
    assert.equal(sessionDoor.getSessionInfo(row.id).model, "fake/first-model");

    const second = await collect(
      runTurn({ ...options, model: "fake/second-model" }),
    );
    assert.equal(provider.calls.request.length, 1, "retry must not call the model");
    assert.equal(second[0].role, EVENT.TURN_START);
    assert.equal(second[0].content.replayed, true);
    assert.equal(second[1].role, EVENT.ASSISTANT);
    assert.equal(second[1].content.text, "only once");
    assert.equal(second[2].role, EVENT.TOKEN);
    assert.equal(second[2].content.input_tokens, 4);
    assert.equal(
      sessionDoor.getSessionInfo(row.id).model,
      "fake/first-model",
      "a replayed duplicate must not change the model override",
    );

    assert.equal(sessionDoor.listTurns(row.id).length, 1);
    const conversation = sessionDoor.getConversation(row.id);
    assert.equal(
      conversation.filter((event) => event.role === EVENT.USER).length,
      1,
    );
  });

  it("aggregates usage across every provider step and records model choice", async () => {
    const provider = createFakeProvider({
      turns: [
        [
          toolCall({ name: "read", arguments: { path: "does-not-exist.txt" } }),
          usage({
            input_tokens: 10,
            output_tokens: 2,
            cached_tokens: 4,
          }),
        ],
        [
          { role: EVENT.ASSISTANT, content: { text: "finished" } },
          usage({ input_tokens: 5, output_tokens: 3, reasoning_tokens: 1 }),
        ],
      ],
    });
    const row = createSession({
      prompt: "use a tool",
      model: "fake/override-model",
    });
    const seen = [];

    const events = await collect(
      runTurn({
        name: "nano",
        prompt: "use a tool",
        session_id: row.id,
        deps: depsFor(provider, {
          model: "fake/config-model",
          seen,
        }),
      }),
    );

    assert.equal(seen[0], "fake/override-model");
    assert.equal(provider.calls.request.length, 2);
    assert.equal(events.at(-2).content.text, "finished");

    const turns = sessionDoor.listTurns(row.id);
    assert.equal(turns.length, 1);
    const turn = sessionDoor.getTurn(turns[0].id);
    assert.equal(turn.status, "complete");
    assert.equal(turn.provider, "fake");
    assert.equal(turn.model, "fake-model");
    assert.deepEqual(turn.usage, {
      requests: 2,
      input_tokens: 15,
      output_tokens: 5,
      total_tokens: 20,
      cached_tokens: 4,
      reasoning_tokens: 1,
    });
    assert.equal(sessionDoor.getSessionInfo(row.id).token, 8);
  });
});

describe("conversation pagination", () => {
  it("returns newest pages with an older-turn cursor", () => {
    const row = createSession({ prompt: "page me" });
    for (let index = 1; index <= 4; index += 1) {
      sessionDoor.beginTurn(row.id, `q${index}`);
      sessionDoor.recordEvent(row.id, {
        role: EVENT.ASSISTANT,
        content: { text: `a${index}` },
      });
      sessionDoor.commitTurn(row.id, index, { input_tokens: index });
    }

    const first = sessionDoor.getConversationPage(row.id, { limit: 2 });
    assert.equal(first.has_more, true);
    assert.equal(typeof first.next_cursor, "string");
    assert.deepEqual(
      first.events.map((event) => event.content.text),
      ["q3", "a3", "q4", "a4"],
    );

    const second = sessionDoor.getConversationPage(row.id, {
      limit: 2,
      before: first.next_cursor,
    });
    assert.equal(second.has_more, false);
    assert.equal(second.next_cursor, null);
    assert.deepEqual(
      second.events.map((event) => event.content.text),
      ["q1", "a1", "q2", "a2"],
    );

    assert.equal(sessionDoor.getConversation(row.id).length, 8);
    assert.equal(sessionDoor.listTurns(row.id).length, 4);
    assert.deepEqual(sessionDoor.listTurns(row.id)[0].usage, {
      input_tokens: 4,
    });

    assert.throws(
      () => sessionDoor.getConversationPage(row.id, { limit: 0 }),
      /between 1 and 500/,
    );
    assert.throws(
      () => sessionDoor.getConversationPage(row.id, { before: "abc" }),
      /positive turn id/,
    );
  });
});
