// test/suite/rate-limit.test.js
// Offline. Uses a 1s window so the suite stays fast.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rateLimit } from "../../gateway/middlewares/rate-limit-middleware.js";
import { ResponseError } from "../../gateway/error/response-error.js";

function fakeRes() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

function run(mw) {
  return new Promise((resolve) => {
    const res = fakeRes();
    mw({ ip: "127.0.0.1" }, res, (error) => resolve({ error, res }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("rate-limit", () => {
  it("rejects bad factory options", () => {
    assert.throws(() => rateLimit({ windowMs: 0, max: 1 }), /windowMs/);
    assert.throws(() => rateLimit({ windowMs: 1000, max: -1 }), /max/);
  });

  it("allows within quota, 429s beyond it, then recovers", async () => {
    const mw = rateLimit({ windowMs: 1000, max: 2, scope: "suite" });

    const first = await run(mw);
    assert.equal(first.error, undefined);
    assert.equal(first.res.headers["X-RateLimit-Limit"], "2");
    assert.equal(first.res.headers["X-RateLimit-Remaining"], "1");

    const second = await run(mw);
    assert.equal(second.error, undefined);
    assert.equal(second.res.headers["X-RateLimit-Remaining"], "0");

    const third = await run(mw);
    assert.ok(third.error instanceof ResponseError);
    assert.equal(third.error.status, 429);
    assert.match(third.error.message, /Rate limit exceeded/);
    assert.ok(third.res.headers["Retry-After"]);

    await sleep(1100);
    const after = await run(mw);
    assert.equal(after.error, undefined);
  });

  it("tracks IPs independently", async () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1, scope: "iso" });
    const other = await new Promise((resolve) => {
      mw({ ip: "10.0.0.9" }, fakeRes(), (error) => resolve(error));
    });
    assert.equal(other, undefined);
  });
});
