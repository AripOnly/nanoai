// test/suite/audit.test.js
// Offline. buildEntry is pure; the middleware itself is verified live.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildEntry, rotateLogFile } from "../../gateway/service/audit-service.js";
import { buildHealth } from "../../gateway/service/health-service.js";

describe("audit entry", () => {
  it("records metadata without request contents", () => {
    const entry = buildEntry(
      {
        ip: "127.0.0.1",
        method: "POST",
        path: "/api/v1/agent",
        body: {
          name: "nano",
          prompt: "TOP SECRET PROMPT",
          session_id: "abc-123",
        },
        params: {},
      },
      { statusCode: 200 },
      321,
    );

    assert.equal(entry.ip, "127.0.0.1");
    assert.equal(entry.method, "POST");
    assert.equal(entry.path, "/api/v1/agent");
    assert.equal(entry.status, 200);
    assert.equal(entry.ms, 321);
    assert.equal(entry.session_id, "abc-123");
    assert.equal(entry.agent, "nano");
    assert.ok(!("prompt" in entry), "prompt contents must never be logged");
    assert.ok(typeof entry.ts === "string");
  });

  it("omits missing session and agent fields", () => {
    const entry = buildEntry(
      { ip: "::1", method: "GET", path: "/health", body: {}, params: {} },
      { statusCode: 200 },
      2,
    );
    assert.ok(!("session_id" in entry));
    assert.ok(!("agent" in entry));
  });
});

describe("audit log rotation", () => {
  it("rotates oversized logs keeping newest files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nano-audit-"));
    const main = path.join(dir, "audit.log");
    fs.writeFileSync(main, "x".repeat(100), "utf8");
    assert.deepEqual(rotateLogFile(main, 5000, 2), { rotated: false });
    fs.writeFileSync(path.join(dir, "audit.log.1"), "old1", "utf8");
    fs.writeFileSync(path.join(dir, "audit.log.2"), "old2", "utf8");
    assert.deepEqual(rotateLogFile(main, 50, 2), { rotated: true });
    assert.ok(fs.readFileSync(path.join(dir, "audit.log.2"), "utf8").includes("old1"));
    assert.ok(!fs.existsSync(path.join(dir, "audit.log.3")));
    assert.deepEqual(rotateLogFile(path.join(dir, "missing.log"), 50, 2), { rotated: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("health probe", () => {
  it("reports status, version and dependency checks", async () => {
    const health = await buildHealth();
    assert.ok(health.status === "ok" || health.status === "degraded");
    assert.equal(typeof health.uptime, "number");
    assert.equal(typeof health.version, "string");
    assert.ok(health.checks && typeof health.checks.settings === "string");
    assert.ok(typeof health.checks.database === "string");
  });
});
