// test/suite/system-route.test.js
// The HTTP shutdown controller is deliberately tiny; these tests pin its
// confirmation, single-flight, and response-before-shutdown behavior without
// opening a listening socket.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { systemController } from "../../gateway/controllers/system-controller.js";

function fakeResponse() {
  const listeners = new Map();
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      setImmediate(() => listeners.get("finish")?.());
      return this;
    },
    once(event, handler) {
      listeners.set(event, handler);
      return this;
    },
  };
}

function request({ body = {}, locals = {} } = {}) {
  return {
    body,
    app: { locals },
    get(name) {
      return this.headers?.[name.toLowerCase()];
    },
  };
}

describe("HTTP shutdown controller", () => {
  it("accepts a confirmed request and shuts down after the response", async () => {
    const calls = [];
    const req = request({
      body: { confirm: "shutdown" },
      locals: {
        shutdown: (reason) => calls.push(reason),
        shuttingDown: false,
      },
    });
    const res = fakeResponse();
    await systemController.shutdown(req, res, () => {
      throw new Error("next() must not be called for a valid request");
    });

    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.body, { status: "accepted", action: "shutdown" });
    assert.equal(calls.length, 0, "shutdown runs after the response finishes");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["HTTP request"]);
  });

  it("requires explicit confirmation", async () => {
    let failure = null;
    const req = request({ locals: { shutdown: () => {}, shuttingDown: false } });
    await systemController.shutdown(req, fakeResponse(), (error) => {
      failure = error;
    });
    assert.equal(failure?.status, 400);
    assert.match(failure.message, /confirm/i);
  });

  it("rejects a second shutdown request", async () => {
    let failure = null;
    const req = request({
      body: { confirm: "shutdown" },
      locals: { shutdown: () => {}, shuttingDown: true },
    });
    await systemController.shutdown(req, fakeResponse(), (error) => {
      failure = error;
    });
    assert.equal(failure?.status, 409);
  });

  it("reports a runtime without a shutdown callback", async () => {
    let failure = null;
    const req = request({
      body: { confirm: "shutdown" },
      locals: { shuttingDown: false },
    });
    await systemController.shutdown(req, fakeResponse(), (error) => {
      failure = error;
    });
    assert.equal(failure?.status, 503);
  });
});
