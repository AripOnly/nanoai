// test/integration/skills-api.test.js
//
// HTTP proof for the read-only skills door: auth, revision headers, the
// metadata-only list, forced reload, and health degradation. Mutations are
// deliberately absent from the API; they stay in `nanoai skills`.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

process.env.NANO_GATEWAY_TOKEN = "skills-api-test-token";

let server;
let baseUrl;
let skills;
let revision;
let lastError;
let healthError;

const records = [
  {
    name: "fixture-pdf",
    description: "Build a PDF report.",
    version: "1.0.0",
    tags: ["pdf"],
    triggers: ["buat laporan pdf"],
    trust: "user-approved",
    source: "./fixtures/fixture-pdf",
    requested: "./fixtures/fixture-pdf",
    resolvedRef: null,
    hash: "0123456789ab",
    contentHash: `sha256:${"a".repeat(64)}`,
    status: "ok",
    compatible: true,
    unavailableReason: null,
    autoLoad: true,
    allowedTools: ["read", "write"],
    os: [],
    requires: { env: [], bins: [] },
    installedAt: "2026-10-21T00:00:00.000Z",
    skillsCliVersion: "1.7.4",
    warnings: [],
  },
];

before(async () => {
  revision = 1;
  lastError = null;
  healthError = null;
  skills = {
    list() {
      return records;
    },
    snapshot() {
      return { revision, lastError };
    },
    stats() {
      return {
        total: records.length,
        compatible: 1,
        trusted: 1,
        external: 0,
        invalid: 0,
        revision,
      };
    },
    health() {
      return {
        revision,
        enabled: true,
        lastError: healthError,
        loadedAt: "2026-10-21T00:00:00.000Z",
        stats: {
          total: records.length,
          compatible: 1,
          trusted: 1,
          external: 0,
          invalid: 0,
        },
      };
    },
    async reload() {
      revision += 1;
      return {
        revision,
        entries: records,
        skills: records,
        stats: { total: records.length },
      };
    },
  };

  const { createApp } = await import("../../gateway/application/web.js");
  const app = await createApp({ runtime: {}, skills });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
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
    Authorization: "Bearer skills-api-test-token",
    ...extra,
  };
}

describe("GET /api/v1/skills", () => {
  it("requires the gateway bearer token", async () => {
    const response = await fetch(`${baseUrl}/api/v1/skills`);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.role, "error");
    assert.match(body.content.message, /gateway token/i);
  });

  it("returns metadata, revision headers, and never a skill body or path", async () => {
    const response = await fetch(`${baseUrl}/api/v1/skills`, {
      headers: headers(),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-skills-revision"), "1");
    assert.ok([null, ""].includes(response.headers.get("x-skills-error")));

    const body = await response.json();
    assert.equal(body.revision, 1);
    assert.equal(body.lastError, null);
    assert.equal(body.skills.length, 1);
    assert.equal(body.skills[0].name, "fixture-pdf");
    assert.equal(body.skills[0].trust, "user-approved");
    assert.equal(body.skills[0].hash.length, 12);
    assert.equal(body.skills[0].status, "ok");
    assert.equal(body.skills[0].allowedTools.join(","), "read,write");
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('"body"'), false);
    assert.equal(serialized.includes('"path"'), false);
    assert.equal(serialized.includes("contentHash"), true);
  });

  it("does not expose install, remove, or update over HTTP", async () => {
    for (const path of ["add", "remove", "update"]) {
      const response = await fetch(`${baseUrl}/api/v1/skills/${path}`, {
        method: "POST",
        headers: headers(),
      });
      assert.equal(response.status, 404, path);
    }
  });
});

describe("POST /api/v1/skills/reload", () => {
  it("forces a registry rebuild and bumps the revision", async () => {
    const response = await fetch(`${baseUrl}/api/v1/skills/reload`, {
      method: "POST",
      headers: headers(),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-skills-revision"), "2");
    const body = await response.json();
    assert.equal(body.revision, 2);
    assert.equal(body.skills.length, 1);
    assert.equal(body.stats.total, 1);

    const list = await fetch(`${baseUrl}/api/v1/skills`, {
      headers: headers(),
    });
    assert.equal(list.headers.get("x-skills-revision"), "2");
    assert.equal((await list.json()).revision, 2);
  });
});

describe("skills health", () => {
  it("reports revision, stats, and an untrusted-autoload warning", async () => {
    const ok = await fetch(`${baseUrl}/health`);
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.checks.skills, "ok");
    assert.equal(okBody.skills_revision, 2);
    assert.equal(okBody.skills_error, null);
    assert.equal(okBody.skills_allow_untrusted_autoload, false);
    assert.equal(okBody.skills_warning, null);
    assert.equal(okBody.skills.stats.total, 1);
  });

  it("warns when allowUntrustedAutoLoad is enabled", async () => {
    const settingsService = (
      await import("../../gateway/service/settings-service.js")
    ).default;
    const before = (await settingsService.getSettings()).skills;
    try {
      await settingsService.updateSettings({
        skills: { allowUntrustedAutoLoad: true },
      });
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.skills_allow_untrusted_autoload, true);
      assert.match(body.skills_warning, /still never auto-loaded/);
    } finally {
      await settingsService.updateSettings({ skills: before });
    }
  });

  it("marks the gateway degraded when the registry reports an error", async () => {
    healthError = "Skill content changed after installation.";
    lastError = healthError;
    try {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.status, "degraded");
      assert.equal(body.checks.skills, healthError);
      assert.equal(body.skills_error, healthError);
    } finally {
      healthError = null;
      lastError = null;
    }
  });
});
