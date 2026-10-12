// test/suite/session-store.test.js
// Offline. Uses the real SQLite file with uniquely-named sessions that are
// deleted afterwards.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  sessionStore,
  nameFromPrompt,
} from "../../src/session/session-store.js";

const IDS = [];

async function makeSession() {
  const row = sessionStore.createSession(
    `test-suite-${Date.now()}-${IDS.length}`,
    "suite prompt",
  );
  IDS.push(row.id);
  return row.id;
}

after(() => {
  for (const id of IDS) {
    try {
      sessionStore.deleteSession(id);
    } catch {
      // Already removed; cleanup must never fail the suite.
    }
  }
});

describe("session-store", () => {
  it("creates a session row with an id", async () => {
    const id = await makeSession();
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);
  });

  it("records a full turn and reads it back", async () => {
    const id = await makeSession();
    sessionStore.start(id, "user", "hello");
    sessionStore.record(id, { role: "assistant", content: { text: "hi" } });
    sessionStore.record(id, { role: "error", content: { message: "boom" } });
    sessionStore.record(id, {
      role: "compaction",
      content: { text: "marker" },
    });
    sessionStore.record(id, { role: "token", content: { total_tokens: 1 } });
    sessionStore.commit(id, 42);

    const roles = sessionStore.getConversation(id).map((e) => e.role);
    assert.ok(roles.includes("user"));
    assert.ok(roles.includes("assistant"));
    assert.ok(roles.includes("error"), "error events must persist");
    assert.ok(roles.includes("compaction"), "markers must persist");
    assert.ok(!roles.includes("token"), "token events stay out of turns");
    assert.equal(sessionStore.getSessionById(id).token, 42);
  });

  it("pruneConversation keeps the keep_turn window after the last marker", async () => {
    const conv = [
      { role: "user", content: { text: "q0" } },
      { role: "assistant", content: { text: "a0" } },
      { role: "user", content: { text: "q1" } },
      { role: "assistant", content: { text: "a1" } },
      { role: "user", content: { text: "q2" } },
      { role: "assistant", content: { text: "a2" } },
      { role: "compaction", content: { text: "s" } },
      { role: "user", content: { text: "q3" } },
      { role: "assistant", content: { text: "a3" } },
    ];
    const pruned = sessionStore.pruneConversation(conv, 2);
    assert.deepEqual(
      pruned.map((e) => e.content.text),
      ["q1", "a1", "q2", "a2", "s", "q3", "a3"],
    );
  });

  it("pruneConversation with an invalid keepTurn returns everything", () => {
    const conv = [{ role: "user", content: { text: "q" } }];
    for (const bad of [0, -2, 1.5, null, undefined, "2"]) {
      assert.equal(sessionStore.pruneConversation(conv, bad).length, 1);
    }
  });

  it("persists the user prompt at start, before commit", async () => {
    const id = await makeSession();
    sessionStore.start(id, "user", "durable prompt");

    const roles = sessionStore.getConversation(id).map((e) => e.role);
    assert.ok(roles.includes("user"), "prompt must survive a crash");

    sessionStore.commit(id, 1);
    assert.ok(
      sessionStore
        .getConversation(id)
        .some(
          (e) => e.role === "user" && e.content.text === "durable prompt",
        ),
    );
  });

  it("recovers an interrupted turn with markers and synthetic results", async () => {
    const id = await makeSession();
    sessionStore.start(id, "user", "do work");
    sessionStore.record(id, {
      role: "assistant",
      content: { text: "partial " },
    });
    sessionStore.record(id, {
      role: "assistant",
      content: { text: "answer" },
    });
    sessionStore.record(id, {
      role: "tool_call",
      content: { call_id: "c1", name: "shell", arguments: {} },
    });
    // No commit: simulates a crash mid-turn.

    assert.equal(sessionStore.recoverInterruptedTurns(id), 1);

    const conversation = sessionStore.getConversation(id);
    const roles = conversation.map((e) => e.role);
    assert.ok(roles.includes("assistant"), "flushed messages survive");
    const result = conversation.find((e) => e.role === "tool_result");
    assert.ok(result, "orphan tool_call gets a synthetic result");
    assert.equal(result.content.call_id, "c1");
    const marker = conversation.find((e) => e.role === "error");
    assert.ok(marker, "interruption marker is attached");
    assert.match(marker.content.message, /interrupted/);

    assert.equal(
      sessionStore.recoverInterruptedTurns(id),
      0,
      "recovery is idempotent",
    );
  });

  it("resumes with a fresh turn after recovery", async () => {
    const id = await makeSession();
    sessionStore.start(id, "user", "first");
    assert.equal(sessionStore.recoverInterruptedTurns(id), 1);

    sessionStore.start(id, "user", "second");
    sessionStore.record(id, { role: "assistant", content: { text: "ok" } });
    sessionStore.commit(id, 3);

    const texts = sessionStore
      .getConversation(id)
      .filter((e) => e.role === "user")
      .map((e) => e.content.text);
    assert.deepEqual(texts, ["first", "second"]);
  });

  it("recoverAllInterruptedTurns sweeps every session", async () => {
    const id = await makeSession();
    sessionStore.start(id, "user", "abandoned");
    const recovered = sessionStore.recoverAllInterruptedTurns();
    assert.ok(recovered >= 1);
  });

  it("skips corrupt turn rows instead of crashing history", async () => {
    const id = await makeSession();
    sessionStore.start(id, "user", "hello");
    sessionStore.commit(id, 7);

    const { default: sql } = await import(
      "../../src/session/sql.js"
    );
    sql
      .prepare("INSERT INTO turn (parts, session_id) VALUES (?, ?)")
      .run("{corrupt-json", id);

    const conversation = sessionStore.getConversation(id);
    assert.ok(
      conversation.some((e) => e.role === "user"),
      "valid rows still load",
    );
  });

  it("validation guards throw clear English messages", () => {
    assert.throws(() => nameFromPrompt("   "), /non-empty string/);
    assert.throws(() => nameFromPrompt(null), /non-empty string/);
    assert.throws(() => sessionStore.getConversation(""), /non-empty string/);
    assert.throws(() => sessionStore.getSessionById(null), /non-empty string/);
    assert.throws(
      () => sessionStore.renameSession("  ", "x"),
      /non-empty string/,
    );
    assert.throws(() => sessionStore.deleteSession(undefined), /non-empty string/);
  });
});
