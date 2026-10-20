// test/suite/agent.test.js
// Offline: unknown-agent and bad-argument paths throw before any LLM call.
// checkCompaction only reads settings. Temp sessions are deleted afterwards.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { agent } from "../../src/agents/agent.js";
import { agentService } from "../../gateway/service/agent-service.js";
import { ResponseError } from "../../gateway/error/response-error.js";
import { checkCompaction } from "../../src/agents/compaction.js";
import { toolExecute } from "../../src/agents/tool-execute.js";
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

describe("agent entry guards", () => {
  it("rejects unknown agents with the available list", async () => {
    const row = sessionStore.createSession("suite-agent", "hi");
    IDS.push(row.id);
    // agent() converts internal failures into error events for the stream,
    // so the guard surfaces as an event rather than a throw.
    const events = [];
    for await (const event of agent({
      name: "raksasa",
      prompt: "halo",
      session_id: row.id,
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

describe("checkCompaction", () => {
  it("fires on huge tokens and stays quiet on tiny ones", async () => {
    assert.equal(
      await checkCompaction({ provider: "google", model: "gemini-3.1-flash-lite", token: 99999999 }),
      true,
    );
    assert.equal(
      await checkCompaction({ provider: "google", model: "gemini-3.1-flash-lite", token: 10 }),
      false,
    );
    assert.equal(
      await checkCompaction({ provider: "google", model: "nope", token: 99999999 }),
      false,
    );
  });
});
