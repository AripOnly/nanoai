// test/contracts/gateway-boot.test.js
//
// Boot order and shutdown wiring are small enough to test without sockets:
// recovery must finish before listen(), and shutdown must abort live turns.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bootGateway, resolveHost } from "../../gateway/boot.js";
import {
  abortActiveTurns,
  trackActiveTurn,
} from "../../gateway/lifecycle/active-turns.js";

describe("gateway boot order", () => {
  it("runs session recovery before binding the port", () => {
    const calls = [];
    const app = {
      listen(port, host) {
        calls.push(["listen", port, host]);
        return { on() {}, requestTimeout: 0 };
      },
    };
    const sessionService = {
      init() {
        calls.push(["init"]);
        return 2;
      },
    };

    const { recovered } = bootGateway({
      app,
      sessionService,
      port: 3060,
      host: "127.0.0.1",
    });

    assert.equal(recovered, 2);
    assert.deepEqual(calls, [
      ["init"],
      ["listen", 3060, "127.0.0.1"],
    ]);
  });

  it("does not listen when recovery fails", () => {
    let listened = false;
    const app = {
      listen() {
        listened = true;
        return { on() {} };
      },
    };
    const sessionService = {
      init() {
        throw new Error("database unavailable");
      },
    };

    assert.throws(
      () => bootGateway({ app, sessionService, port: 3060, host: "127.0.0.1" }),
      /database unavailable/,
    );
    assert.equal(listened, false);
  });

  it("binds loopback by default and honors HOST", () => {
    assert.equal(resolveHost({}), "127.0.0.1");
    assert.equal(resolveHost({ HOST: "   " }), "127.0.0.1");
    assert.equal(resolveHost({ HOST: "0.0.0.0" }), "0.0.0.0");
  });
});

describe("shutdown active turns", () => {
  it("aborts every tracked turn and forgets cleaned-up ones", () => {
    const cleaned = new AbortController();
    const live = new AbortController();
    const untrack = trackActiveTurn(cleaned);
    trackActiveTurn(live);
    untrack();

    abortActiveTurns(new Error("shutdown"));

    assert.equal(cleaned.signal.aborted, false);
    assert.equal(live.signal.aborted, true);
    assert.match(live.signal.reason.message, /shutdown/);
  });

  it("is safe to call twice", () => {
    const controller = new AbortController();
    trackActiveTurn(controller);

    abortActiveTurns();
    assert.doesNotThrow(() => abortActiveTurns());
    assert.equal(controller.signal.aborted, true);
  });
});
