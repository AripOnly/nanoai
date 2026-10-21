// test/suite/agent.test.js
// Offline: unknown-agent and bad-argument paths fail before any LLM call.
// shouldCompact is a pure threshold check. Temp sessions are deleted after.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { runTurn } from "../../src/runtime/turn.js";
import { shouldCompact } from "../../src/runtime/compaction.js";
import * as sessionDoor from "../../src/session/index.js";
import { agentService } from "../../gateway/service/agent-service.js";
import { ResponseError } from "../../gateway/error/response-error.js";
import { toolExecute } from "../../src/tools/executor.js";
import { sessionStore } from "../../src/session/session-store.js";

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

function deps() {
  return {
    session: sessionDoor,
    getConfig: () => ({
      model: "google/gemini-3.1-flash-lite",
      username: "tester",
      compaction: { ratio: 85, keep_turn: 2 },
    }),
    getCatalog: () => null,
    resolveModel: async () => {
      throw new Error("model resolution must not run for an unknown agent");
    },
    logger: { warn() {}, error() {} },
  };
}

describe("agent entry guards", () => {
  it("rejects unknown agents with the available list", async () => {
    const row = sessionStore.createSession("suite-agent", "hi");
    IDS.push(row.id);
    // runTurn converts internal failures into error events for the stream, so
    // the guard surfaces as an event rather than a throw.
    const events = [];
    for await (const event of runTurn({
      name: "raksasa",
      prompt: "halo",
      session_id: row.id,
      deps: deps(),
    })) {
      events.push(event);
    }
    const failures = events.filter((e) => e.role === "error");
    assert.ok(failures.length > 0, "expected an error event");
    assert.match(failures[0].content.message, /Unknown agent "raksasa"/);
    assert.match(failures[0].content.message, /nano/);
    // User-facing errors are messages, never raw stack traces.
    assert.ok(
      !/\n\s+at /.test(failures[0].content.message),
      "error event must not leak a stack trace",
    );
  });

  it("agentService validates before streaming and throws 400s", () => {
    assert.throws(
      () => agentService({ name: "raksasa", prompt: "halo" }),
      (error) =>
        error instanceof ResponseError &&
        error.status === 400 &&
        /Unknown agent "raksasa"/.test(error.message),
    );
    assert.throws(
      () => agentService({ name: "nano", prompt: "   " }),
      (error) =>
        error instanceof ResponseError &&
        error.status === 400 &&
        /prompt must be a non-empty string/.test(error.message),
    );
  });

  it("toolExecute names the tool on bad JSON arguments", async () => {
    const result = await toolExecute({
      name: "read",
      arguments: "{not json",
    });
    assert.equal(result.success, false);
    assert.match(result.error, /Tool "read" received invalid arguments/);
  });

  it("toolExecute reports unknown tools clearly", async () => {
    const result = await toolExecute({ name: "nope", arguments: {} });
    assert.equal(result.success, false);
    assert.match(result.error, /Tool "nope" not found/);
  });
});

describe("shouldCompact", () => {
  it("fires on huge tokens and stays quiet on tiny ones", () => {
    assert.equal(
      shouldCompact({ token: 99_999_999, contextWindow: 1_048_576, ratio: 85 }),
      true,
    );
    assert.equal(
      shouldCompact({ token: 10, contextWindow: 1_048_576, ratio: 85 }),
      false,
    );
    assert.equal(
      shouldCompact({ token: 99_999_999, contextWindow: 0, ratio: 85 }),
      false,
    );
  });
});
