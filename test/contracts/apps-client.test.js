// test/contracts/apps-client.test.js
//
// The shared door client is the only HTTP/SSE implementation used by the CLI
// and the browser. These tests pin frame splitting, auth, error envelopes, and
// streamed event parsing without depending on a running gateway.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  GatewayError,
  createGatewayClient,
  isGatewayConnectionError,
  parseSSEStream,
} from "#client";

let server;
let baseUrl;
let lastAuth = null;

before(async () => {
  server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization ?? null;

    if (req.url === "/api/v1/session/list-session") {
      if (req.headers.authorization !== "Bearer secret") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            role: "error",
            content: { message: "Unauthorized" },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ id: "s1", name: "one" }]));
      return;
    }

    if (req.url === "/api/v1/session/s1?limit=2&before=9") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          events: [{ role: "assistant", content: { text: "page" } }],
          next_cursor: "8",
          has_more: true,
        }),
      );
      return;
    }

    if (req.url === "/api/v1/agent") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      // Deliberately split a frame and a CRLF pair across chunks.
      res.write('data: {"role":"turn_start","content":{"turn_id":1}}\r');
      res.write('\n\r\ndata: {"role":"assistant",');
      res.write('"content":{"text":"hel');
      res.write('lo"}}\n\n');
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ role: "error", content: { message: "nope" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(async () => {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("shared apps client", () => {
  it("attaches the injected token and parses JSON", async () => {
    const client = createGatewayClient({
      baseUrl,
      getToken: () => "secret",
    });
    assert.deepEqual(await client.listSessions(), [
      { id: "s1", name: "one" },
    ]);
    assert.equal(lastAuth, "Bearer secret");
    assert.equal(client.baseUrl, baseUrl);
  });

  it("builds pagination queries and surfaces auth errors", async () => {
    const client = createGatewayClient({ baseUrl, token: "secret" });
    const page = await client.getConversation("s1", {
      limit: 2,
      before: 9,
    });
    assert.equal(page.has_more, true);
    assert.equal(page.next_cursor, "8");

    const bad = createGatewayClient({ baseUrl, token: "wrong" });
    await assert.rejects(
      bad.listSessions(),
      (error) =>
        error instanceof GatewayError &&
        error.status === 401 &&
        error.code === "UNAUTHORIZED" &&
        /Unauthorized/.test(error.message),
    );
  });

  it("parses SSE frames split across chunks and CRLF boundaries", async () => {
    const client = createGatewayClient({ baseUrl, token: "secret" });
    const events = [];
    for await (const event of client.streamAgent({
      name: "nano",
      prompt: "hi",
      session_id: "s1",
    })) {
      events.push(event);
    }
    assert.deepEqual(events, [
      { role: "turn_start", content: { turn_id: 1 } },
      { role: "assistant", content: { text: "hello" } },
    ]);
  });

  it("reads a raw stream even when the final frame has no blank line", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"role":"assistant",'),
        );
        controller.enqueue(
          new TextEncoder().encode('"content":{"text":"done"}}'),
        );
        controller.close();
      },
    });
    const events = [];
    for await (const event of parseSSEStream(stream)) events.push(event);
    assert.deepEqual(events, [
      { role: "assistant", content: { text: "done" } },
    ]);
  });

  it("marks connection failures so the CLI can suppress only those", async () => {
    const client = createGatewayClient({
      baseUrl: "http://127.0.0.1:1/api/v1",
      token: "secret",
      timeoutMs: 500,
    });
    await assert.rejects(
      client.listSessions(),
      (error) =>
        isGatewayConnectionError(error) &&
        error.code === "GATEWAY_UNREACHABLE",
    );
  });
});
