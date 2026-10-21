// test/suite/settings.test.js
// Offline except for reading local files. Invalid updates throw before any
// write. Runs against an isolated NANO_DATA_DIR (see test/setup.js), so the
// write round-trips below never touch the developer's real config.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { configPath } from "../../src/config/config.js";
import settingsService from "../../gateway/service/settings-service.js";
import { ResponseError } from "../../gateway/error/response-error.js";

const SETTINGS_PATH = configPath();
const BACKUP_PATH = `${SETTINGS_PATH}.suite-backup`;

async function exists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

before(async () => {
  if (await exists(SETTINGS_PATH)) {
    await fs.copyFile(SETTINGS_PATH, BACKUP_PATH);
  }
});

after(async () => {
  if (await exists(BACKUP_PATH)) {
    await fs.copyFile(BACKUP_PATH, SETTINGS_PATH);
    await fs.unlink(BACKUP_PATH);
  }
});

async function rejectsResponseError(promise, status, pattern) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ResponseError);
    assert.equal(error.status, status);
    assert.match(error.message, pattern);
    return;
  }
  assert.fail("expected a ResponseError");
}

describe("settings-service", () => {
  it("masks secrets on read", async () => {
    const current = await settingsService.getSettings();
    for (const key of ["api_key", "serper_api_key"]) {
      const value = current[key];
      if (typeof value === "string" && value.length > 0) {
        assert.ok(value.startsWith("****"), `${key} must be masked`);
        assert.ok(value.length <= 12, `${key} must not leak the full secret`);
      }
    }
    assert.ok(typeof current.model === "string");
    assert.ok(typeof current.compaction === "object");
  });

  it("rejects unknown keys, empty bodies, and non-objects", async () => {
    await rejectsResponseError(
      settingsService.updateSettings({ nope: 1 }),
      400,
      /unknown setting/,
    );
    await rejectsResponseError(settingsService.updateSettings({}), 400, /empty/);
    await rejectsResponseError(settingsService.updateSettings([]), 400, /object/);
  });

  it("validates model format and provider", async () => {
    await rejectsResponseError(
      settingsService.updateSettings({ model: "xxx" }),
      400,
      /provider\/model/,
    );
    await rejectsResponseError(
      settingsService.updateSettings({ model: "raksasa/x" }),
      400,
      /unknown provider/,
    );
    await rejectsResponseError(
      settingsService.updateSettings({ model: "google/nope" }),
      400,
      /unknown model/,
    );
  });

  it("validates secrets and compaction", async () => {
    await rejectsResponseError(
      settingsService.updateSettings({ api_key: "" }),
      400,
      /non-empty string or null/,
    );
    await rejectsResponseError(
      settingsService.updateSettings({ compaction: { ratio: 101 } }),
      400,
      /between 1 and 100/,
    );
    await rejectsResponseError(
      settingsService.updateSettings({ compaction: { keep_turn: 0 } }),
      400,
      />= 1/,
    );
    await rejectsResponseError(
      settingsService.updateSettings({ cors_origins: "x" }),
      400,
      /array/,
    );
  });

  it("validates skills settings and merges partial updates", async () => {
    await rejectsResponseError(
      settingsService.updateSettings({ skills: "on" }),
      400,
      /skills must be an object/,
    );
    await rejectsResponseError(
      settingsService.updateSettings({ skills: { nope: true } }),
      400,
      /unknown key/,
    );
    await rejectsResponseError(
      settingsService.updateSettings({ skills: { enabled: "yes" } }),
      400,
      /must be a boolean/,
    );
    await rejectsResponseError(
      settingsService.updateSettings({ skills: { maxCatalogEntries: 0 } }),
      400,
      /between 1 and 1000/,
    );
    await rejectsResponseError(
      settingsService.updateSettings({ skills: { maxSupportingFileBytes: 1023 } }),
      400,
      /between 1024/,
    );

    const before = (await settingsService.getSettings()).skills;
    try {
      const updated = await settingsService.updateSettings({
        skills: { autoLoadTrusted: false },
      });
      assert.equal(updated.skills.autoLoadTrusted, false);
      assert.equal(updated.skills.enabled, before.enabled);
      assert.equal(
        updated.skills.allowUntrustedAutoLoad,
        before.allowUntrustedAutoLoad,
      );
    } finally {
      await settingsService.updateSettings({ skills: before });
    }
  });

  it("validates provider_keys shape and values", async () => {
    await rejectsResponseError(
      settingsService.updateSettings({ provider_keys: [] }),
      400,
      /object/,
    );
    await rejectsResponseError(
      settingsService.updateSettings({ provider_keys: { google: "" } }),
      400,
      /non-empty string or null/,
    );
  });

  it("merges provider_keys and masks them on read", async () => {
    await settingsService.updateSettings({
      provider_keys: { __suite_a: "SECRET-AAA-1111" },
    });
    let current = await settingsService.getSettings();
    assert.equal(current.provider_keys.__suite_a, "****1111");

    await settingsService.updateSettings({
      provider_keys: { __suite_b: "SECRET-BBB-2222" },
    });
    current = await settingsService.getSettings();
    assert.equal(current.provider_keys.__suite_a, "****1111");
    assert.equal(current.provider_keys.__suite_b, "****2222");

    await settingsService.updateSettings({
      provider_keys: { __suite_a: null, __suite_b: null },
    });
    current = await settingsService.getSettings();
    assert.ok(!("__suite_a" in (current.provider_keys ?? {})));
    assert.ok(!("__suite_b" in (current.provider_keys ?? {})));
  });

  it("lists providers with models", async () => {
    const providers = settingsService.listProviders();
    const google = providers.find((p) => p.provider === "google");
    assert.ok(google);
    assert.ok(google.models.length > 0);
    assert.ok(google.models.every((m) => typeof m.id === "string"));
  });

  it("round-trips a username write and never echoes secrets", async () => {
    const before = await settingsService.getSettings();
    const updated = await settingsService.updateSettings({
      username: "__suite__",
    });
    assert.equal(updated.username, "__suite__");
    for (const key of ["api_key", "serper_api_key"]) {
      const value = updated[key];
      if (typeof value === "string" && value.length > 0) {
        assert.ok(value.startsWith("****"), `${key} must stay masked`);
      }
    }
    const restored = await settingsService.updateSettings({
      username: before.username,
    });
    assert.equal(restored.username, before.username);
  });
});
