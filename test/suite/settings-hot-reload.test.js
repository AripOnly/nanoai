// test/suite/settings-hot-reload.test.js
//
// Fase 1.5 contract: one settings snapshot, one revision per update, atomic
// replacement, live external reload with last-known-good behavior, and live
// token/CORS consumers. The suite uses its own NANO_DATA_DIR (test/setup.js),
// so it never touches the developer's real config.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configPath,
  getSnapshot,
  initSettings,
  settings,
  startSettingsWatcher,
  stopSettingsWatcher,
} from "../../src/config/index.js";
import settingsService from "../../gateway/service/settings-service.js";
import { getGatewayToken } from "../../gateway/auth/token.js";
import { getOrigins, initOrigins } from "../../gateway/auth/origins.js";
import { buildHealth } from "../../gateway/service/health-service.js";
import { resolveListen } from "../../gateway/boot.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function readFileJson() {
  return JSON.parse(await fs.readFile(configPath(), "utf8"));
}

const originalCorsEnv = process.env.NANO_CORS_ORIGINS;
const originalTokenEnv = process.env.NANO_GATEWAY_TOKEN;
const projectRoot = path.resolve(import.meta.dirname, "../..");

before(async () => {
  await initSettings();
  startSettingsWatcher();
});

after(() => {
  stopSettingsWatcher();
  if (originalCorsEnv === undefined) {
    delete process.env.NANO_CORS_ORIGINS;
  } else {
    process.env.NANO_CORS_ORIGINS = originalCorsEnv;
  }
  if (originalTokenEnv === undefined) {
    delete process.env.NANO_GATEWAY_TOKEN;
  } else {
    process.env.NANO_GATEWAY_TOKEN = originalTokenEnv;
  }
});

describe("settings snapshot", () => {
  it("creates a validated default file and freezes the snapshot", async () => {
    const snapshot = getSnapshot();
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.value.model, "google/gemini-3.1-flash-lite");
    assert.deepEqual(snapshot.value.cors_origins, []);
    assert.deepEqual(snapshot.value.gateway, { host: null, port: null });
    assert.equal(Object.isFrozen(snapshot.value), true);

    const stored = await readFileJson();
    assert.equal(stored.model, "google/gemini-3.1-flash-lite");
    assert.equal(stored.gateway_token, null);

    assert.throws(() => {
      snapshot.value.username = "mutated";
    }, TypeError);
  });

  it("fails fast on invalid boot config without overwriting the user file", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "nanoai-invalid-boot-"),
    );
    const file = path.join(directory, "nano.config.json");
    const content = "{ this is not valid json";
    await fs.writeFile(file, content, "utf8");

    const script =
      'import("./src/config/index.js").then(async (m) => {' +
      "try { await m.initSettings(); process.exit(0); }" +
      "catch (error) { console.error(error.message); process.exit(7); }" +
      "});";
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          NANO_DATA_DIR: directory,
          NANOAI_SKIP_MIGRATION: "1",
        },
        encoding: "utf8",
      },
    );

    try {
      assert.equal(result.status, 7, result.stderr);
      assert.match(result.stderr, /not valid JSON/i);
      assert.equal(await fs.readFile(file, "utf8"), content);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("applies a multi-key API update in exactly one revision", async () => {
    const before = getSnapshot().revision;
    const result = await settingsService.updateSettingsWithMeta({
      username: "Arip",
      model: "google/gemini-3.6-flash",
      provider_keys: { google: "SECRET-ABCD" },
      compaction: { ratio: 70 },
    });
    const updated = result.data;

    const snapshot = getSnapshot();
    assert.equal(snapshot.revision, before + 1);
    assert.equal(result.revision, snapshot.revision);
    assert.equal(result.restartRequired, false);
    assert.equal(snapshot.value.username, "Arip");
    assert.equal(snapshot.value.model, "google/gemini-3.6-flash");
    assert.equal(snapshot.value.compaction.ratio, 70);
    assert.equal(snapshot.value.compaction.keep_turn, 2);
    assert.equal(snapshot.value.provider_keys.google, "SECRET-ABCD");
    assert.equal(updated.provider_keys.google, "****ABCD");
    assert.equal(settingsService.getSettingsMeta().revision, snapshot.revision);

    // The watcher sees our own atomic write; the content hash dedupe must not
    // bump the revision a second time.
    await delay(1400);
    assert.equal(getSnapshot().revision, snapshot.revision);
  });

  it("serializes concurrent updates without losing keys", async () => {
    const before = getSnapshot().revision;
    await Promise.all([
      settings.update({ username: "concurrent-one" }),
      settings.update({ api_key: "legacy-key" }),
      settings.update({ provider_keys: { google: "concurrent-key" } }),
    ]);

    const snapshot = getSnapshot();
    assert.equal(snapshot.revision, before + 3);
    assert.equal(snapshot.value.username, "concurrent-one");
    assert.equal(snapshot.value.api_key, "legacy-key");
    assert.equal(snapshot.value.provider_keys.google, "concurrent-key");

    const stored = await readFileJson();
    assert.equal(stored.username, "concurrent-one");

    const entries = await fs.readdir(path.dirname(configPath()));
    assert.equal(
      entries.some((entry) => entry.endsWith(".tmp")),
      false,
      "no temp file should remain after atomic writes",
    );

    if (process.platform !== "win32") {
      const stat = await fs.stat(configPath());
      assert.equal(stat.mode & 0o777, 0o600);
    }
  });

  it("reloads an external edit within two seconds", async () => {
    const raw = await readFileJson();
    const before = getSnapshot().revision;
    raw.username = "external-editor";
    await fs.writeFile(configPath(), `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    await waitFor(() => getSnapshot().value.username === "external-editor", 2500);
    assert.equal(getSnapshot().source, "file");
    assert.equal(getSnapshot().revision, before + 1);
  });

  it("keeps last-known-good on invalid JSON and recovers when fixed", async () => {
    const before = getSnapshot();
    await fs.writeFile(configPath(), "{ this is not json", "utf8");

    await waitFor(() => getSnapshot().lastError !== null, 2500);
    assert.match(getSnapshot().lastError, /JSON/i);
    assert.equal(getSnapshot().value.username, before.value.username);
    assert.equal(getSnapshot().revision, before.revision);

    const health = await buildHealth();
    assert.equal(health.status, "degraded");
    assert.match(health.settings_error, /JSON/i);
    assert.equal(health.settings_revision, before.revision);

    const repaired = {
      ...before.value,
      username: "recovered-from-invalid",
    };
    await fs.writeFile(
      configPath(),
      `${JSON.stringify(repaired, null, 2)}\n`,
      "utf8",
    );

    await waitFor(
      () =>
        getSnapshot().lastError === null &&
        getSnapshot().value.username === "recovered-from-invalid",
      2500,
    );
    assert.equal(getSnapshot().revision, before.revision + 1);
  });

  it("marks gateway host/port changes as restart-required", async () => {
    const before = getSnapshot().revision;
    const updated = await settingsService.updateSettings({
      gateway: { host: "0.0.0.0", port: 3071 },
    });

    assert.equal(getSnapshot().revision, before + 1);
    assert.deepEqual(getSnapshot().value.gateway, {
      host: "0.0.0.0",
      port: 3071,
    });
    assert.equal(getSnapshot().restartRequired, true);
    assert.equal(updated.gateway.port, 3071);

    const health = await buildHealth();
    assert.equal(health.restart_required, true);

    assert.deepEqual(
      resolveListen({
        env: {},
        gateway: { host: "127.0.0.1", port: 3060 },
      }),
      { host: "127.0.0.1", port: 3060 },
    );
    assert.deepEqual(
      resolveListen({
        env: { HOST: "0.0.0.0", PORT: "4000" },
        gateway: { host: "127.0.0.1", port: 3060 },
      }),
      { host: "0.0.0.0", port: 4000 },
    );
  });

  it("rejects unknown nested gateway keys without writing", async () => {
    const before = getSnapshot().revision;
    await assert.rejects(
      settingsService.updateSettings({ gateway: { hostname: "x" } }),
      (error) => error.status === 400 && /unknown key/.test(error.message),
    );
    assert.equal(getSnapshot().revision, before);
  });

  it("enforces If-Match against the current revision", async () => {
    const current = getSnapshot().revision;
    await assert.rejects(
      settingsService.updateSettings(
        { username: "stale-writer" },
        { ifMatch: current - 1 },
      ),
      (error) => error.status === 409,
    );
    assert.equal(getSnapshot().revision, current);
  });
});

describe("hot consumers", () => {
  it("applies cors_origins immediately and merges the environment", async () => {
    await initOrigins();

    await settingsService.updateSettings({
      cors_origins: ["http://dashboard.example"],
    });
    assert.deepEqual(getOrigins(), ["http://dashboard.example"]);

    await assert.rejects(
      settingsService.updateSettings(
        { cors_origins: [] },
        { origin: "http://dashboard.example" },
      ),
      (error) =>
        error.status === 400 && /remove the origin of the current request/.test(
          error.message,
        ),
    );
    assert.deepEqual(getOrigins(), ["http://dashboard.example"]);

    await settingsService.updateSettings({ cors_origins: [] });
    assert.deepEqual(getOrigins(), []);

    process.env.NANO_CORS_ORIGINS = "http://env.example, http://second.example";
    assert.deepEqual(getOrigins(), [
      "http://env.example",
      "http://second.example",
    ]);
    delete process.env.NANO_CORS_ORIGINS;
  });

  it("generates the token once and lets the environment override it", async () => {
    delete process.env.NANO_GATEWAY_TOKEN;

    const first = await getGatewayToken();
    assert.equal(first.created, true);
    assert.match(first.token, /^[a-f0-9]{64}$/);

    const second = await getGatewayToken();
    assert.equal(second.created, false);
    assert.equal(second.token, first.token);

    process.env.NANO_GATEWAY_TOKEN = "environment-token";
    try {
      const override = await getGatewayToken();
      assert.equal(override.token, "environment-token");

      await assert.rejects(
        settingsService.updateSettings({ gateway_token: "from-api" }),
        (error) => error.status === 409,
      );
    } finally {
      delete process.env.NANO_GATEWAY_TOKEN;
    }
  });
});
