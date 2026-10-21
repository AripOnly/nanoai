// test/integration/models-api.test.js
//
// End-to-end HTTP proof for GET /api/v1/models: auth, revision/error headers,
// safe availability metadata, and the flat provider/model shape. The app runs
// on an ephemeral localhost port with the test NANO_DATA_DIR.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

process.env.NANO_GATEWAY_TOKEN = "models-api-test-token";
delete process.env.NANO_GOOGLE_API_KEY;

let server;
let baseUrl;

before(async () => {
  const { createApp } = await import("../../gateway/application/web.js");
  const app = await createApp({ runtime: {} });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function headers(extra = {}) {
  return {
    Authorization: "Bearer models-api-test-token",
    ...extra,
  };
}

describe("GET /api/v1/models", () => {
  it("requires the gateway bearer token", async () => {
    const response = await fetch(`${baseUrl}/api/v1/models`);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.role, "error");
    assert.match(body.content.message, /gateway token/i);
  });

  it("returns a flat, credential-free catalog with revision metadata", async () => {
    const response = await fetch(`${baseUrl}/api/v1/models`, {
      headers: headers(),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-models-revision"), "1");
    assert.equal(response.headers.get("x-models-error"), null);

    const body = await response.json();
    assert.equal(body.revision, 1);
    assert.equal(body.lastError, null);
    assert.ok(Array.isArray(body.models));
    assert.ok(body.models.length > 0);

    const model = body.models.find(
      (entry) => entry.provider === "google" && entry.id === "gemini-3.1-flash-lite",
    );
    assert.ok(model, "default catalog model must be listed");
    assert.equal(model.name, "Gemini 3.1 Flash Lite");
    assert.equal(model.wire, "google-interactions");
    assert.equal(typeof model.contextWindow, "number");
    assert.equal(typeof model.maxOutputTokens, "number");
    assert.equal(model.capabilities.streaming, true);
    assert.equal(model.status, "active");
    assert.equal(model.available, false);
    assert.equal(model.unavailableReason, "credential_missing");
    assert.equal(JSON.stringify(body).includes("apiKey"), false);
    assert.equal(JSON.stringify(body).includes("provider_keys"), false);
  });

  it("marks a model available when its provider key is present", async () => {
    process.env.NANO_GOOGLE_API_KEY = "test-only-key";
    try {
      const response = await fetch(`${baseUrl}/api/v1/models`, {
        headers: headers(),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      const model = body.models.find(
        (entry) => entry.provider === "google",
      );
      assert.equal(model.available, true);
      assert.equal(model.unavailableReason, null);
    } finally {
      delete process.env.NANO_GOOGLE_API_KEY;
    }
  });

  it("exposes models metadata in the public health probe", async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.checks.models, "ok");
    assert.equal(body.models_revision, 1);
    assert.equal(body.models_error, null);
  });
});
