// test/suite/session-busy.test.js
//
// One live turn per session. The store guard is the last line of defence; the
// gateway preflight turns the common case into HTTP 409 before SSE starts.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  sessionStore,
  SessionBusyError,
} from "../../src/session/session-store.js";
import { agentService } from "../../gateway/service/agent-service.js";
import { ResponseError } from "../../gateway/error/response-error.js";
import { EVENT } from "../../src/shared/event-type.js";

const IDS = [];

function makeSession() {
  const row = sessionStore.createSession(
    `busy-suite-${Date.now()}-${IDS.length}`,
    "busy prompt",
  );
  IDS.push(row.id);
  return row.id;
}

after(() => {
  for (const id of IDS) {
    try {
      sessionStore.deleteSession(id);
    } catch {
      // Cleanup must never fail the suite.
    }
  }
});

describe("session busy guard", () => {
  it("allows only one live turn and preserves the first history", () => {
    const id = makeSession();

    sessionStore.start(id, EVENT.USER, "first");
    assert.equal(sessionStore.isActive(id), true);
    assert.throws(
      () => sessionStore.start(id, EVENT.USER, "second"),
      SessionBusyError,
    );

    // A default recovery sweep must not abort the live turn.
    assert.equal(sessionStore.recoverInterruptedTurns(id), 0);
    assert.equal(sessionStore.isActive(id), true);

    sessionStore.record(id, {
      role: EVENT.ASSISTANT,
      content: { text: "first answer" },
    });
    sessionStore.commit(id, 1);
    assert.equal(sessionStore.isActive(id), false);

    sessionStore.start(id, EVENT.USER, "second");
    sessionStore.record(id, {
      role: EVENT.ASSISTANT,
      content: { text: "second answer" },
    });
    sessionStore.commit(id, 2);

    const users = sessionStore
      .getConversation(id)
      .filter((event) => event.role === EVENT.USER)
      .map((event) => event.content.text);
    assert.deepEqual(users, ["first", "second"]);
  });

  it("maps a busy session to HTTP 409 before streaming", () => {
    const id = makeSession();
    sessionStore.start(id, EVENT.USER, "live");

    assert.throws(
      () =>
        agentService({
          name: "nano",
          prompt: "second",
          session_id: id,
        }),
      (error) =>
        error instanceof ResponseError &&
        error.status === 409 &&
        /active turn/.test(error.message),
    );
  });

  it("recovery with includeActive clears a simulated crash writer", () => {
    const id = makeSession();
    sessionStore.start(id, EVENT.USER, "abandoned");

    assert.equal(
      sessionStore.recoverInterruptedTurns(id, { includeActive: true }),
      1,
    );
    assert.equal(sessionStore.isActive(id), false);
    sessionStore.start(id, EVENT.USER, "fresh");
    sessionStore.commit(id, 0);
  });

  it("rejects internal subagents at the gateway door", () => {
    const id = makeSession();
    assert.throws(
      () =>
        agentService({
          name: "compaction",
          prompt: "summarise",
          session_id: id,
        }),
      (error) => error instanceof ResponseError && error.status === 400,
    );
  });
});
