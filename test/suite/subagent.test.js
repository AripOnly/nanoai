// test/suite/subagent.test.js
//
// Fase 5 proof: a delegated subagent gets a fresh child session, only the
// explicit task/context, its own read-only tool set, and returns one bounded
// report. Child events stream for observability but never enter the parent's
// stored conversation.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as sessionDoor from "../../src/session/index.js";
import { sessionStore } from "../../src/session/session-store.js";
import { runTurn } from "../../src/runtime/turn.js";
import { createSubagentRunner } from "../../src/runtime/subagent.js";
import { getAgent } from "../../src/agents/index.js";
import { getAgentDefinition } from "../../src/agents/registry.js";
import { EVENT } from "../../src/shared/event-type.js";
import {
  FAKE_MODEL,
  createFakeProvider,
  errorEvent,
  textTurn,
  toolCall,
  toolTurn,
  usage,
} from "../helpers/fake-provider.js";

const IDS = [];

after(() => {
  for (const id of IDS) {
    try {
      sessionStore.deleteSession(id);
    } catch {
      // Cleanup must never fail the suite.
    }
  }
});

function track(row) {
  IDS.push(row.id);
  return row;
}

function createConfig() {
  return {
    model: "fake-subagent/fake-model",
    username: "tester",
    compaction: { ratio: 85, keep_turn: 2 },
  };
}

function createDeps(provider, overrides = {}) {
  return {
    session: sessionDoor,
    getConfig: () => createConfig(),
    getCatalog: () => null,
    resolveModel: async () => ({
      adapter: provider,
      model: FAKE_MODEL,
      limits: {
        contextWindow: FAKE_MODEL.contextWindow,
        maxOutputTokens: FAKE_MODEL.maxOutputTokens,
      },
      capabilities: FAKE_MODEL.capabilities,
    }),
    logger: { warn() {}, error() {} },
    ...overrides,
  };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function runParentWithDelegate(provider) {
  const parent = track(sessionDoor.createSession({ name: "parent" }));
  const deps = createDeps(provider);
  deps.subagent = createSubagentRunner({
    session: sessionDoor,
    runTurn,
    deps,
    logger: deps.logger,
  });

  const events = await collect(
    runTurn({
      name: "nano",
      prompt: "Parent work only. Delegate the search.",
      session_id: parent.id,
      deps,
      policy: getAgent("nano").policy,
    }),
  );

  return { parent, deps, events };
}

describe("Fase 5 explore subagent", () => {
  it("runs in a fresh child session and returns only a bounded report", async () => {
    const provider = createFakeProvider({
      id: "fake-subagent",
      turns: [
        toolTurn({
          call_id: "parent-delegate",
          name: "delegate",
          arguments: {
            agent: "explore",
            task: "Find where the session door lives.",
            context: "The answer is under src/session. Report paths only.",
          },
        }),
        textTurn("src/session/index.js: the module door for session storage."),
        textTurn("Parent final answer."),
      ],
    });

    const { parent, events } = await runParentWithDelegate(provider);

    const toolResult = events.find(
      (event) =>
        event.role === EVENT.TOOL_RESULT &&
        event.content?.name === "delegate",
    );
    assert.ok(toolResult, "delegate must return a tool result");
    assert.equal(toolResult.content.result.status, "completed");
    assert.match(toolResult.content.result.summary, /src\/session\/index\.js/);
    assert.equal(toolResult.content.result.usage.requests, 1);
    const childId = toolResult.content.result.childSessionId;
    assert.ok(childId);

    const child = sessionDoor.getSession(childId);
    assert.equal(child.kind, "subagent");
    assert.equal(child.parent_session_id, parent.id);
    assert.equal(child.model, "fake-subagent/fake-model");

    // The child's provider request contains only the delegated task and the
    // explicit parent context; it never receives the parent prompt.
    const childRequest = provider.calls.request[1];
    assert.equal(childRequest.session_id, childId);
    assert.match(childRequest.input[0].content.text, /Find where the session door lives/);
    assert.match(childRequest.input[0].content.text, /src\/session/);
    assert.doesNotMatch(childRequest.input[0].content.text, /Parent work only/);

    const childTools = childRequest.tools.map((tool) => tool.name);
    assert.ok(childTools.includes("read"));
    assert.ok(!childTools.includes("delegate"));
    assert.ok(!childTools.includes("shell"));
    assert.ok(!childTools.includes("write"));

    // Child lifecycle events stream to the parent, but are transient: the
    // stored parent conversation never contains them.
    const roles = events.map((event) => event.role);
    assert.ok(roles.includes(EVENT.SUBAGENT_START));
    assert.ok(roles.includes(EVENT.SUBAGENT_END));
    const storedParent = sessionDoor
      .getConversation(parent.id)
      .map((event) => event.role);
    assert.ok(!storedParent.includes(EVENT.SUBAGENT_START));
    assert.ok(!storedParent.includes(EVENT.SUBAGENT_END));
    assert.ok(!storedParent.includes(EVENT.SUBAGENT_UPDATE));

    // The child transcript is separate from the parent transcript.
    const childConversation = sessionDoor.getConversation(childId);
    assert.ok(
      childConversation.some(
        (event) =>
          event.role === EVENT.ASSISTANT &&
          /src\/session\/index\.js/.test(event.content?.text ?? ""),
      ),
    );
    assert.ok(
      !sessionDoor
        .getConversation(parent.id)
        .some(
          (event) =>
            event.role === EVENT.ASSISTANT &&
            /src\/session\/index\.js/.test(event.content?.text ?? ""),
        ),
      "the full child answer must not be merged into the parent transcript",
    );
  });

  it("lets the parent continue after the child fails", async () => {
    const provider = createFakeProvider({
      id: "fake-subagent",
      turns: [
        toolTurn({
          call_id: "parent-delegate",
          name: "delegate",
          arguments: {
            agent: "explore",
            task: "Find the thing.",
          },
        }),
        [errorEvent("child provider unavailable")],
        textTurn("Parent recovered from the failed child."),
      ],
    });

    const { events } = await runParentWithDelegate(provider);
    const toolResult = events.find(
      (event) =>
        event.role === EVENT.TOOL_RESULT &&
        event.content?.name === "delegate",
    );

    assert.equal(toolResult.content.result.status, "failed");
    assert.match(toolResult.content.result.error, /child provider unavailable/);
    assert.ok(
      events.some(
        (event) =>
          event.role === EVENT.ASSISTANT &&
          /Parent recovered/.test(event.content?.text ?? ""),
      ),
      "the parent must be able to continue after a delegated failure",
    );
    assert.equal(provider.calls.request.length, 3);
  });

  it("denies an invented delegate call inside the child", async () => {
    const provider = createFakeProvider({
      id: "fake-subagent",
      turns: [
        toolTurn({
          call_id: "parent-delegate",
          name: "delegate",
          arguments: {
            agent: "explore",
            task: "Try to delegate again.",
          },
        }),
        [
          toolCall({
            call_id: "child-delegate",
            name: "delegate",
            arguments: {
              agent: "explore",
              task: "This must not run.",
            },
          }),
          usage({ input_tokens: 4, output_tokens: 2 }),
        ],
        textTurn("Child final report."),
        textTurn("Parent final answer."),
      ],
    });

    const { events } = await runParentWithDelegate(provider);
    const updates = events.filter(
      (event) => event.role === EVENT.SUBAGENT_UPDATE,
    );
    assert.ok(
      updates.some(
        (event) =>
          event.content?.status === "tool_failed" &&
          event.content?.tool === "delegate",
      ),
      "the child's invented delegate call must be refused",
    );

    const childTools = provider.calls.request[1].tools.map((tool) => tool.name);
    assert.ok(!childTools.includes("delegate"));
  });

  it("rejects depth greater than one before creating a child session", async () => {
    const session = {
      created: 0,
      createSession() {
        this.created += 1;
        return { id: "should-not-exist" };
      },
    };
    const runner = createSubagentRunner({
      session,
      runTurn: async function* () {
        yield* [];
      },
      deps: {},
    });

    const result = await runner(
      { agent: "explore", task: "nested" },
      { depth: 1 },
    );

    assert.equal(result.status, "failed");
    assert.match(result.error, /depth .* 1/);
    assert.equal(session.created, 0);
  });

  it("bounds the explicit context and rejects unknown agents", async () => {
    const session = { createSession: () => ({ id: "child" }) };
    const runner = createSubagentRunner({
      session,
      runTurn: async function* () {
        yield* [];
      },
      deps: {},
      maxContextBytes: 8,
    });

    const unknown = await runner(
      { agent: "worker", task: "do work" },
      {},
    );
    assert.equal(unknown.status, "failed");
    assert.match(unknown.error, /non-delegatable/);

    const tooLarge = await runner(
      { agent: "explore", task: "explore", context: "123456789" },
      {},
    );
    assert.equal(tooLarge.status, "failed");
    assert.match(tooLarge.error, /context exceeds/);
  });

  it("bounds the report returned to the parent", async () => {
    const session = {
      createSession: () => ({ id: "child-summary" }),
    };
    const runner = createSubagentRunner({
      session,
      deps: {},
      maxSummaryBytes: 32,
      runTurn: async function* () {
        yield {
          role: EVENT.ASSISTANT,
          content: { text: "x".repeat(200) },
        };
      },
    });

    const result = await runner(
      { agent: "explore", task: "find it" },
      {},
    );

    assert.equal(result.status, "completed");
    assert.ok(Buffer.byteLength(result.summary, "utf8") <= 32);
    assert.match(result.summary, /truncated/);
  });

  it("aborts the child when the parent signal aborts", async () => {
    const parent = new AbortController();
    let childSignal;
    const session = {
      createSession: () => ({ id: "child-abort" }),
    };
    const runner = createSubagentRunner({
      session,
      deps: {},
      runTurn: async function* (options) {
        childSignal = options.signal;
        parent.abort(new Error("parent stopped"));
        if (options.signal.aborted) return;
        yield { role: EVENT.ASSISTANT, content: { text: "too late" } };
      },
    });

    const result = await runner(
      { agent: "explore", task: "keep looking" },
      { signal: parent.signal },
    );

    assert.equal(result.status, "aborted");
    assert.equal(childSignal.aborted, true);
    assert.match(result.error, /aborted/);
  });

  it("turns a child timeout into a failed result", async () => {
    const session = {
      createSession: () => ({ id: "child-timeout" }),
    };
    const runner = createSubagentRunner({
      session,
      deps: {},
      timeoutMs: 10,
      runTurn: async function* (options) {
        await new Promise((resolve) => {
          options.signal.addEventListener("abort", resolve, { once: true });
        });
        if (options.signal.aborted) return;
        yield { role: EVENT.ASSISTANT, content: { text: "late" } };
      },
    });

    const result = await runner(
      { agent: "explore", task: "slow" },
      {},
    );

    assert.equal(result.status, "failed");
    assert.match(result.error, /timed out/);
    assert.equal(result.childSessionId, "child-timeout");
  });

  it("reports a provider error as a failed result", async () => {
    const session = {
      createSession: () => ({ id: "child-error" }),
    };
    const runner = createSubagentRunner({
      session,
      deps: {},
      runTurn: async function* () {
        yield {
          role: EVENT.ERROR,
          content: { message: "provider unavailable" },
        };
      },
    });

    const result = await runner(
      { agent: "explore", task: "find it" },
      {},
    );

    assert.equal(result.status, "failed");
    assert.match(result.error, /provider unavailable/);
    assert.equal(result.childSessionId, "child-error");
  });

  it("only advertises delegate when the runtime injected a runner", async () => {
    const explore = getAgentDefinition("explore");
    assert.ok(!explore.tools.includes("delegate"));

    const provider = createFakeProvider({
      id: "fake-subagent",
      turns: [textTurn("hello")],
    });
    const session = track(sessionDoor.createSession({ name: "parent-tools" }));
    const deps = createDeps(provider);

    await collect(
      runTurn({
        name: "nano",
        prompt: "hi",
        session_id: session.id,
        deps,
      }),
    );

    const tools = provider.calls.request[0].tools.map((tool) => tool.name);
    assert.ok(!tools.includes("delegate"));
  });
});
