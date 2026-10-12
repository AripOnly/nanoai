// test/suite/error-middleware.test.js
// Offline. The middleware must wrap every backend error in the event
// envelope { role: "error", content: { message } } with the right status.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { errorMiddleware } from "../../gateway/middlewares/error-middleware.js";
import { ResponseError } from "../../gateway/error/response-error.js";

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("error-middleware", () => {
  it("maps ResponseError to its status with the error envelope", async () => {
    const res = fakeRes();
    await errorMiddleware(new ResponseError(400, "bad input"), {}, res, () => {});
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
      role: "error",
      content: { message: "bad input" },
    });
  });

  it("maps unexpected errors to 500 with the error envelope", async () => {
    const res = fakeRes();
    await errorMiddleware(new Error("kaboom"), {}, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, {
      role: "error",
      content: { message: "kaboom" },
    });
  });

  it("honors upstream HTTP statuses such as the body parser's 400", async () => {
    const res = fakeRes();
    const syntax = new SyntaxError("Expected property name");
    syntax.status = 400;
    await errorMiddleware(syntax, {}, res, () => {});
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.role, "error");
  });

  it("ignores empty errors via next()", async () => {
    let nextCalled = false;
    await errorMiddleware(null, {}, fakeRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });
});
