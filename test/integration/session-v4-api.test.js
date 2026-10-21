// test/integration/session-v4-api.test.js
//
// HTTP proof for Fase 3: channel identity, model override, paginated
// conversation reads, and the new agent request fields reaching the runtime.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import * as sessionDoor from "../../src/session/index.js";
import { EVENT } from "../../src/shared/event-type.js";

process.env.NANO_GATEWAY_TOKEN = "session-v4-api-test-token";

let server;
let baseUrl;
let sessionId;
const runtimeCalls = [];

const runtime = {
  async *runTurn(input) {
    runtimeCalls.push(input);
    yield {
      role: EVENT.TURN_START,
      content: { turn_id: 99, session_id: input.session_id ?? null },
    };
    yield { role: EVENT.ASSISTANT, content: { text: "streamed" } };
  },
};

before(async () => {
  const { createApp } = await import("../../gateway/application/web.js");
  const app = await createApp({ runtime });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (sessionId) {
    try {
      sessionDoor.deleteSession(sessionId);
    } catch {
      // Cleanup must never fail the suite.
    }
  }
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function headers(extra = {}) {
  return {
    Authorization: `Bearer ${process.env.NANO_GATEWAY_TOKEN}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function json(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: headers(options.headers),
  });
  const body = await response.json();
  return { response, body };
}

describe("session v4 HTTP API", () => {
  it("creates and resolves a channel identity, then updates its model", async () => {
    const created = await json("/api/v1/session/", {
      method: "POST",
      body: JSON.stringify({
        prompt: "api channel session",
        channel: "discord",
        external_ref: "guild-9",
        model: "fake/initial",
      }),
    });
    assert.equal(created.response.status, 200);
    sessionId = created.body.id;
    assert.equal(created.body.channel, "discord");
    assert.equal(created.body.external_ref, "guild-9");
    assert.equal(created.body.model, "fake/initial");

    const resolved = await json("/api/v1/session/resolve", {
      method: "POST",
      body: JSON.stringify({
        channel: "discord",
        external_ref: "guild-9",
      }),
    });
    assert.equal(resolved.response.status, 200);
    assert.equal(resolved.body.id, sessionId);

    const updated = await json(`/api/v1/session/${sessionId}`, {
      method: "PUT",
      body: JSON.stringify({ model: "fake/updated" }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.model, "fake/updated");

    const info = await json(`/api/v1/session/info/${sessionId}`);
    assert.equal(info.response.status, 200);
    assert.equal(info.body.model, "fake/updated");
  });

  it("returns legacy arrays without a query and pages with limit/before", async () => {
    for (let index = 1; index <= 3; index += 1) {
      sessionDoor.beginTurn(sessionId, `q${index}`);
      sessionDoor.recordEvent(sessionId, {
        role: EVENT.ASSISTANT,
        content: { text: `a${index}` },
      });
      sessionDoor.commitTurn(sessionId, index);
    }

    const legacy = await json(`/api/v1/session/${sessionId}`);
    assert.equal(legacy.response.status, 200);
    assert.ok(Array.isArray(legacy.body));
    assert.equal(legacy.body.length, 6);

    const page = await json(`/api/v1/session/${sessionId}?limit=2`);
    assert.equal(page.response.status, 200);
    assert.equal(page.body.has_more, true);
    assert.deepEqual(
      page.body.events.map((event) => event.content.text),
      ["q2", "a2", "q3", "a3"],
    );

    const older = await json(
      `/api/v1/session/${sessionId}?limit=2&before=${page.body.next_cursor}`,
    );
    assert.equal(older.response.status, 200);
    assert.equal(older.body.has_more, false);
    assert.deepEqual(
      older.body.events.map((event) => event.content.text),
      ["q1", "a1"],
    );

    const turns = await json(`/api/v1/session/${sessionId}/turns?limit=1`);
    assert.equal(turns.response.status, 200);
    assert.equal(turns.body.length, 1);
    assert.equal(turns.body[0].status, "complete");

    const invalid = await json(`/api/v1/session/${sessionId}?limit=0`);
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.body.content.message, /limit/);
  });

  it("passes channel identity and client_message_id through to the runtime", async () => {
    const response = await fetch(`${baseUrl}/api/v1/agent`, {
      method: "POST",
      headers: headers({ Accept: "text/event-stream" }),
      body: JSON.stringify({
        name: "nano",
        prompt: "from a channel",
        channel: "telegram",
        external_ref: "chat-123",
        client_message_id: "channel-msg-1",
        model: "fake/channel-model",
      }),
    });

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event:? ?|data: /);
    assert.match(text, /"role":"turn_start"/);
    assert.match(text, /"role":"assistant"/);

    const call = runtimeCalls.at(-1);
    assert.equal(call.channel, "telegram");
    assert.equal(call.external_ref, "chat-123");
    assert.equal(call.client_message_id, "channel-msg-1");
    assert.equal(call.model, "fake/channel-model");
    assert.equal(call.session_id, null);
  });

  it("rejects ambiguous or missing session identity before streaming", async () => {
    const ambiguous = await json("/api/v1/agent", {
      method: "POST",
      body: JSON.stringify({
        name: "nano",
        prompt: "hello",
        session_id: "s1",
        channel: "telegram",
        external_ref: "x",
      }),
    });
    assert.equal(ambiguous.response.status, 400);
    assert.match(ambiguous.body.content.message, /either session_id/);

    const missing = await json("/api/v1/agent", {
      method: "POST",
      body: JSON.stringify({ name: "nano", prompt: "hello" }),
    });
    assert.equal(missing.response.status, 400);
    assert.match(missing.body.content.message, /session_id or channel/);
  });
});
