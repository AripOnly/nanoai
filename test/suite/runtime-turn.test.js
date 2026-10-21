// test/suite/runtime-turn.test.js
//
// Runtime turn orchestration with injected dependencies: no network, no
// global provider registry, and no real session database. The fake session
// mirrors the door's single-flight/persist/commit semantics closely enough to
// assert the lifecycle, and the scripted provider records every request.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTurn } from "../../src/runtime/turn.js";
import { SessionBusyError } from "../../src/session/index.js";
import { sessionStore } from "../../src/session/session-store.js";
import { EVENT } from "../../src/shared/event-type.js";
import {
  FAKE_MODEL,
  createFakeProvider,
  errorEvent,
  textTurn,
  toolCall,
  usage,
} from "../helpers/fake-provider.js";

const SESSION_ID = "session-runtime-test";

function cloneEvent(event) {
  return {
    ...event,
    content:
      event.content && typeof event.content === "object"
        ? { ...event.content }
        : event.content,
  };
}

function createFakeSession({ token = 0, summary = null, conversation = [] } = {}) {
  const row = { id: SESSION_ID, token, summary };
  const state = {
    busy: false,
    recovered: 0,
    began: 0,
    autoNamed: null,
    commits: [],
    events: [],
    summaries: [],
    conversation: conversation.map(cloneEvent),
  };

  return {
    state,
    getSession(id) {
      return id === SESSION_ID ? { ...row } : undefined;
    },
    isSessionBusy(id) {
      return id === SESSION_ID && state.busy;
    },
    recoverInterruptedTurn(id) {
      assert.equal(id, SESSION_ID);
      state.recovered += 1;
    },
    beginTurn(id, prompt) {
      assert.equal(id, SESSION_ID);
      if (state.busy) throw new SessionBusyError(id);
      state.busy = true;
      state.began += 1;
      state.prompt = prompt;
    },
    autoNameSession(id, prompt) {
      assert.equal(id, SESSION_ID);
      state.autoNamed = prompt;
    },
    getConversation(id) {
      assert.equal(id, SESSION_ID);
      return state.conversation.map(cloneEvent);
    },
    pruneConversation(conversation, keepTurn) {
      return sessionStore.pruneConversation(conversation, keepTurn);
    },
    recordEvent(id, event) {
      assert.equal(id, SESSION_ID);
      state.events.push(event);
    },
    getSummary(id) {
      assert.equal(id, SESSION_ID);
      return row.summary;
    },
    compactSession(id, nextSummary) {
      assert.equal(id, SESSION_ID);
      row.summary = nextSummary;
      state.summaries.push(nextSummary);
    },
    commitTurn(id, nextToken = null) {
      assert.equal(id, SESSION_ID);
      state.busy = false;
      state.commits.push(nextToken);
      if (nextToken != null) row.token = nextToken;
    },
  };
}

function defaultConfig(overrides = {}) {
  return {
    model: "fake/fake-model",
    username: "tester",
    compaction: { ratio: 85, keep_turn: 2 },
    ...overrides,
  };
}

function depsFor({
  session,
  provider,
  config = defaultConfig(),
  resolveModel,
  logger = { error() {}, warn() {} },
}) {
  return {
    session,
    getConfig: () => config,
    getCatalog: () => null,
    resolveModel:
      resolveModel ??
      (async () => ({
        adapter: provider,
        model: FAKE_MODEL,
        limits: {
          contextWindow: FAKE_MODEL.contextWindow,
          maxOutputTokens: FAKE_MODEL.maxOutputTokens,
        },
        capabilities: FAKE_MODEL.capabilities,
      })),
    logger,
  };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function textParts(input) {
  return input
    .filter(
      (event) =>
        event.role === EVENT.USER || event.role === EVENT.ASSISTANT,
    )
    .map((event) => event.content.text);
}

describe("runtime runTurn", () => {
  it("runs a normal turn, applies the policy floor, and commits usage", async () => {
    const provider = createFakeProvider({
      turns: [textTurn("hello", { input_tokens: 7, output_tokens: 3 })],
    });
    const session = createFakeSession();
    const events = await collect(
      runTurn({
        name: "nano",
        prompt: "hi",
        session_id: SESSION_ID,
        policy: { maxSteps: 999, allowShell: false },
        deps: depsFor({ session, provider }),
      }),
    );

    assert.deepEqual(
      events.map((event) => event.role),
      [EVENT.TURN_START, EVENT.ASSISTANT, EVENT.TOKEN],
    );
    assert.equal(events[0].content.session_id, SESSION_ID);
    assert.equal(events[0].content.replayed, false);
    assert.equal(events[1].content.text, "hello");
    assert.equal(session.state.began, 1);
    assert.equal(session.state.recovered, 1);
    assert.equal(session.state.autoNamed, "hi");
    assert.equal(session.state.busy, false);
    assert.deepEqual(session.state.commits, [10]);

    const request = provider.calls.request[0];
    assert.equal(request.model, FAKE_MODEL);
    assert.equal(request.input[0].role, EVENT.USER);
    assert.equal(request.input[0].content.text, "hi");
    assert.equal(request.policy.maxSteps, 40, "caller cannot raise maxSteps");
    assert.equal(request.policy.allowShell, false);
    assert.ok(request.tools.some((tool) => tool.name === "read"));
    assert.ok(request.tools.some((tool) => tool.name === "shell"));
    assert.equal(request.session_id, SESSION_ID);
  });

  it("rejects a busy session without calling the provider", async () => {
    const provider = createFakeProvider();
    const session = createFakeSession();
    session.state.busy = true;

    await assert.rejects(
      collect(
        runTurn({
          name: "nano",
          prompt: "hi",
          session_id: SESSION_ID,
          deps: depsFor({ session, provider }),
        }),
      ),
      (error) => error instanceof SessionBusyError,
    );
    assert.equal(provider.calls.request.length, 0);
    assert.equal(session.state.began, 0);
    assert.deepEqual(session.state.commits, []);
  });

  it("turns resolver failures into an error event and still releases the turn", async () => {
    const provider = createFakeProvider();
    const session = createFakeSession();
    const logs = [];
    const events = await collect(
      runTurn({
        name: "nano",
        prompt: "hi",
        session_id: SESSION_ID,
        deps: depsFor({
          session,
          provider,
          resolveModel: async () => {
            const error = new Error("No API key configured for provider \"google\".");
            error.code = "CREDENTIAL_MISSING";
            throw error;
          },
          logger: {
            warn() {},
            error(label, message) {
              logs.push({ label, message });
            },
          },
        }),
      }),
    );

    assert.deepEqual(
      events.map((event) => event.role),
      [EVENT.TURN_START, EVENT.ERROR],
    );
    assert.match(events[1].content.message, /No API key configured/);
    assert.equal(provider.calls.request.length, 0);
    assert.equal(session.state.busy, false);
    assert.equal(session.state.commits.length, 1);
    assert.equal(session.state.events[0].role, EVENT.ERROR);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].message, "No API key configured for provider \"google\".");
  });

  it("honours a pre-aborted signal without opening a turn", async () => {
    const provider = createFakeProvider();
    const session = createFakeSession();
    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      runTurn({
        name: "nano",
        prompt: "hi",
        session_id: SESSION_ID,
        signal: controller.signal,
        deps: depsFor({ session, provider }),
      }),
    );

    assert.deepEqual(events, []);
    assert.equal(provider.calls.request.length, 0);
    assert.equal(session.state.began, 0);
    assert.deepEqual(session.state.commits, []);
  });

  it("compacts history before a turn and prunes the provider input", async () => {
    const conversation = [
      { role: EVENT.USER, content: { text: "q1" } },
      { role: EVENT.ASSISTANT, content: { text: "a1" } },
      { role: EVENT.USER, content: { text: "q2" } },
      { role: EVENT.ASSISTANT, content: { text: "a2" } },
      { role: EVENT.USER, content: { text: "q3" } },
      { role: EVENT.ASSISTANT, content: { text: "a3" } },
    ];
    const provider = createFakeProvider({
      turns: [textTurn("summary"), textTurn("answer")],
    });
    const session = createFakeSession({ token: 900_000, conversation });

    const events = await collect(
      runTurn({
        name: "nano",
        prompt: "hi",
        session_id: SESSION_ID,
        deps: depsFor({ session, provider }),
      }),
    );

    assert.equal(provider.calls.request.length, 2);
    assert.equal(provider.calls.request[0].tools.length, 0);
    assert.ok(textParts(provider.calls.request[0].input).includes("q1"));
    assert.deepEqual(session.state.summaries, ["summary"]);
    assert.equal(session.getSummary(SESSION_ID), "summary");

    const secondInput = textParts(provider.calls.request[1].input);
    assert.ok(secondInput.includes("q2"));
    assert.ok(secondInput.includes("q3"));
    assert.ok(secondInput.includes("hi"));
    assert.ok(secondInput.includes("answer"));
    assert.equal(secondInput.includes("q1"), false);

    assert.ok(events.some((event) => event.role === EVENT.COMPACTION));
    assert.equal(events.at(-2).role, EVENT.ASSISTANT);
    assert.equal(events.at(-2).content.text, "answer");
    assert.equal(events.at(-1).role, EVENT.TOKEN);
    assert.equal(session.state.busy, false);
  });

  it("compacts between tool steps and continues with the summary", async () => {
    const conversation = [
      { role: EVENT.USER, content: { text: "q1" } },
      { role: EVENT.ASSISTANT, content: { text: "a1" } },
      { role: EVENT.USER, content: { text: "q2" } },
      { role: EVENT.ASSISTANT, content: { text: "a2" } },
      { role: EVENT.USER, content: { text: "q3" } },
      { role: EVENT.ASSISTANT, content: { text: "a3" } },
    ];
    const provider = createFakeProvider({
      turns: [
        [
          toolCall({
            name: "read",
            arguments: { path: "runtime-missing-file.txt" },
          }),
          usage({ input_tokens: 900_000, output_tokens: 1 }),
        ],
        textTurn("mid-summary"),
        textTurn("final"),
      ],
    });
    const session = createFakeSession({ conversation });

    const events = await collect(
      runTurn({
        name: "nano",
        prompt: "hi",
        session_id: SESSION_ID,
        deps: depsFor({ session, provider }),
      }),
    );

    assert.equal(provider.calls.request.length, 3);
    assert.deepEqual(session.state.summaries, ["mid-summary"]);
    assert.ok(events.some((event) => event.role === EVENT.TOOL_RESULT));
    assert.ok(events.some((event) => event.role === EVENT.COMPACTION));
    assert.equal(events.at(-2).role, EVENT.ASSISTANT);
    assert.equal(events.at(-2).content.text, "final");

    const finalRequest = provider.calls.request[2];
    assert.match(finalRequest.instruction, /mid-summary/);
    const finalInput = textParts(finalRequest.input);
    assert.ok(finalInput.includes("q3"));
    assert.ok(finalInput.includes("hi"));
    assert.equal(finalInput.includes("q1"), false);
    assert.equal(finalInput.includes("q2"), false);
    assert.equal(session.state.busy, false);
  });

  it("closes the turn when initial compaction fails", async () => {
    const provider = createFakeProvider({
      turns: [[errorEvent("summary engine down")]],
    });
    const session = createFakeSession({
      token: 900_000,
      conversation: [
        { role: EVENT.USER, content: { text: "q1" } },
        { role: EVENT.ASSISTANT, content: { text: "a1" } },
        { role: EVENT.USER, content: { text: "q2" } },
        { role: EVENT.ASSISTANT, content: { text: "a2" } },
        { role: EVENT.USER, content: { text: "q3" } },
        { role: EVENT.ASSISTANT, content: { text: "a3" } },
      ],
    });

    const events = await collect(
      runTurn({
        name: "nano",
        prompt: "hi",
        session_id: SESSION_ID,
        deps: depsFor({ session, provider }),
      }),
    );

    assert.equal(provider.calls.request.length, 1);
    assert.deepEqual(
      events.map((event) => event.role),
      [EVENT.TURN_START, EVENT.ERROR],
    );
    assert.match(events[1].content.message, /summary engine down/);
    assert.equal(session.state.busy, false);
    assert.equal(session.state.commits.length, 1);
  });
});
