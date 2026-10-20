// test/contracts/agent-controller.test.js
//
// Transport behaviour without Express: deferred SSE headers (so 409/400 can
// still be plain HTTP), client-disconnect abort, backpressure, and mid-stream
// error framing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAgentController } from "../../gateway/controllers/agent-controller.js";
import { ResponseError } from "../../gateway/error/response-error.js";
import { EVENT } from "../../src/shared/event-type.js";

class FakeResponse extends EventEmitter {
  constructor({ writeResults = [], onWrite } = {}) {
    super();
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
    this.writeResults = [...writeResults];
    this.onWrite = onWrite;
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  write(chunk) {
    this.chunks.push(chunk);
    this.headersSent = true;
    const index = this.chunks.length - 1;
    this.onWrite?.(chunk, index);
    const result =
      this.writeResults.length > 0 ? this.writeResults.shift() : true;
    if (!result) setImmediate(() => this.emit("drain"));
    return result;
  }

  end() {
    this.writableEnded = true;
    this.emit("finish");
  }

  events() {
    return this.chunks.map((chunk) =>
      JSON.parse(chunk.slice("data: ".length)),
    );
  }
}

function fakeRequest(body = {}) {
  const req = new EventEmitter();
  req.body = body;
  req.aborted = false;
  return req;
}

describe("agent controller SSE", () => {
  it("streams events and a terminal DONE event", async () => {
    const controller = createAgentController(async function* () {
      yield { role: EVENT.ASSISTANT, content: { text: "hello" } };
      yield { role: EVENT.TOKEN, content: { total_tokens: 3 } };
    });
    const req = fakeRequest();
    const res = new FakeResponse();
    let nextError;

    await controller(req, res, (error) => {
      nextError = error;
    });

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/event-stream");
    assert.equal(res.chunks.length, 3);
    assert.deepEqual(
      res.events().map((event) => event.role ?? event.type),
      [EVENT.ASSISTANT, EVENT.TOKEN, EVENT.DONE],
    );
    assert.equal(res.writableEnded, true);
  });

  it("keeps a pre-stream 409 as a plain HTTP error", async () => {
    const controller = createAgentController(async function* () {
      throw new ResponseError(409, "Session is busy.");
    });
    const req = fakeRequest();
    const res = new FakeResponse();
    let nextError;

    await controller(req, res, (error) => {
      nextError = error;
    });

    assert.ok(nextError instanceof ResponseError);
    assert.equal(nextError.status, 409);
    assert.equal(res.headersSent, false);
    assert.equal(res.chunks.length, 0);
    assert.equal(res.statusCode, null);
  });

  it("aborts the service and stops writing when the client disconnects", async () => {
    let aborted = false;
    const controller = createAgentController(async function* (_request, { signal }) {
      yield { role: EVENT.ASSISTANT, content: { text: "first" } };
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", resolve, { once: true });
      });
      aborted = signal.aborted;
    });
    const req = fakeRequest();
    const res = new FakeResponse({
      onWrite: (_chunk, index) => {
        if (index !== 0) return;
        setImmediate(() => {
          res.destroyed = true;
          res.emit("close");
        });
      },
    });
    let nextError;

    await controller(req, res, (error) => {
      nextError = error;
    });

    assert.equal(aborted, true);
    assert.equal(nextError, undefined);
    assert.equal(res.chunks.length, 1, "no DONE or error after disconnect");
  });

  it("waits for drain before writing the next event", async () => {
    const controller = createAgentController(async function* () {
      yield { role: EVENT.ASSISTANT, content: { text: "one" } };
      yield { role: EVENT.ASSISTANT, content: { text: "two" } };
    });
    const req = fakeRequest();
    const res = new FakeResponse({ writeResults: [false, true, true] });

    await controller(req, res, () => {});

    assert.equal(res.chunks.length, 3);
    assert.deepEqual(
      res.events().map((event) => event.role ?? event.type),
      [EVENT.ASSISTANT, EVENT.ASSISTANT, EVENT.DONE],
    );
    assert.equal(res.writableEnded, true);
  });

  it("frames a mid-stream failure as an SSE error event", async () => {
    const controller = createAgentController(async function* () {
      yield { role: EVENT.ASSISTANT, content: { text: "partial" } };
      throw new ResponseError(500, "model exploded");
    });
    const req = fakeRequest();
    const res = new FakeResponse();

    await controller(req, res, () => {});

    const events = res.events();
    assert.equal(events.length, 2);
    assert.equal(events[1].role, EVENT.ERROR);
    assert.match(events[1].content.message, /model exploded/);
    assert.equal(res.writableEnded, true);
  });
});
