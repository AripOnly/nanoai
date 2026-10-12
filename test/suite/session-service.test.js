// test/suite/session-service.test.js
// Offline. Exercises the service layer with temp sessions that are deleted
// afterwards. Mirrors what the CLI now does over HTTP.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import sessionService from "../../gateway/service/session-service.js";
import { ResponseError } from "../../gateway/error/response-error.js";
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

describe("session-service", () => {
  it("renames a session and reads it back", () => {
    const row = sessionService.createSession("rename me please");
    IDS.push(row.id);
    assert.ok(row.name.length > 0);

    const renamed = sessionService.renameSession(row.id, "baru");
    assert.equal(renamed.name, "baru");
    assert.equal(sessionService.getSessionInfo(row.id).name, "baru");
  });

  it("rejects empty rename names", () => {
    const row = sessionService.createSession("temp name check");
    IDS.push(row.id);
    assert.throws(
      () => sessionService.renameSession(row.id, "   "),
      (error) =>
        error instanceof ResponseError &&
        error.status === 400 &&
        /non-empty string/.test(error.message),
    );
  });

  it("deletes a session", () => {
    const row = sessionService.createSession("delete me please");
    const result = sessionService.deleteSession(row.id);
    assert.deepEqual(result, { deleted: true });
    assert.equal(sessionService.getSessionInfo(row.id), undefined);
  });

  it("session info exposes the token counter for CLIs", () => {
    const row = sessionService.createSession("token check please");
    IDS.push(row.id);
    const info = sessionService.getSessionInfo(row.id);
    assert.ok("token" in info);
  });
});
