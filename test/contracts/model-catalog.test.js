// test/contracts/model-catalog.test.js
//
// Model metadata is pure data. These tests lock the v2 catalog shape, the
// first-slash model ref parser, the immutable query view, and the
// revisioned last-known-good reload behavior. No provider SDK is imported.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CatalogError,
  createCatalogStore,
  loadCatalogSync,
  validateCatalog,
} from "../../src/models/catalog.js";
import { createModelRegistry } from "../../src/models/registry.js";
import { ModelRefError, parseModelRef } from "../../src/models/ref.js";

const TEMP_DIRS = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nanoai-model-catalog-"));
  TEMP_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const dir of TEMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function model(overrides = {}) {
  return {
    provider: "google",
    id: "gemini-test",
    name: "Gemini Test",
    wire: "google-interactions",
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    capabilities: {
      streaming: true,
      toolCalling: true,
      vision: true,
    },
    status: "active",
    ...overrides,
  };
}

function catalog(models = [model()], overrides = {}) {
  return { schemaVersion: 2, models, ...overrides };
}

function writeCatalog(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function waitFor(predicate, { timeout = 3_000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch {
        // Keep polling until the deadline; the assertion reports the failure.
      }
      if (Date.now() >= deadline) {
        return reject(new Error("Timed out waiting for the catalog to reload."));
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

describe("model refs", () => {
  it("splits on the first slash so nested model ids survive", () => {
    assert.deepEqual(parseModelRef("openrouter/deepseek/deepseek-chat"), {
      provider: "openrouter",
      id: "deepseek/deepseek-chat",
      ref: "openrouter/deepseek/deepseek-chat",
    });
    assert.deepEqual(parseModelRef("  google/gemini-3.1-flash-lite  "), {
      provider: "google",
      id: "gemini-3.1-flash-lite",
      ref: "google/gemini-3.1-flash-lite",
    });
  });

  it("rejects missing providers, missing ids, and non-strings", () => {
    for (const bad of [null, undefined, 42, "", "google", "/model", "google/", " / "]) {
      assert.throws(() => parseModelRef(bad), ModelRefError);
    }
  });
});

describe("model catalog validation", () => {
  it("ships a valid multi-provider catalog with explicit wires", () => {
    const shipped = loadCatalogSync(
      path.join(process.cwd(), "config", "models.json"),
    );
    const registry = createModelRegistry({ ...shipped, revision: 1 });

    assert.deepEqual([...registry.providers()].sort(), [
      "anthropic",
      "google",
      "openai",
      "opencode-zen",
      "openrouter",
    ]);
    assert.ok(registry.find("google", "gemini-3.1-flash-lite"));
    assert.equal(
      registry.find("openai", "gpt-5.5").wire,
      "openai-responses",
    );
    assert.equal(
      registry.find("anthropic", "claude-sonnet-5-5").wire,
      "anthropic-messages",
    );
    assert.equal(
      registry.find("openrouter", "deepseek/deepseek-v4.1-flash").wire,
      "openai-chat",
    );
    assert.equal(
      registry.find("opencode-zen", "gpt-5.5").wire,
      "openai-responses",
    );
    assert.equal(
      registry.find("opencode-zen", "deepseek-v4.1-flash").wire,
      "openai-chat",
    );
    assert.equal(shipped.models.length, 15);
  });

  it("freezes a valid catalog and fills absent capabilities with false", () => {
    const validated = validateCatalog(
      catalog([
        model({
          capabilities: { streaming: true },
        }),
      ]),
    );

    assert.equal(validated.schemaVersion, 2);
    assert.ok(Object.isFrozen(validated));
    assert.ok(Object.isFrozen(validated.models));
    assert.ok(Object.isFrozen(validated.models[0]));
    assert.equal(validated.models[0].status, "active");
    assert.equal(validated.models[0].capabilities.streaming, true);
    assert.equal(validated.models[0].capabilities.toolCalling, false);
    assert.equal(validated.models[0].capabilities.vision, false);
  });

  it("rejects duplicate provider/model pairs", () => {
    assert.throws(
      () => validateCatalog(catalog([model(), model()])),
      (error) =>
        error instanceof CatalogError && /duplicate entry: google\/gemini-test/.test(error.message),
    );
  });

  it("rejects wrong schema versions and unknown keys", () => {
    assert.throws(
      () => validateCatalog(catalog([model()], { schemaVersion: 1 })),
      /schemaVersion must be 2/,
    );
    assert.throws(
      () => validateCatalog({ ...catalog(), extra: true }),
      /unknown key "extra"/,
    );
    assert.throws(
      () => validateCatalog(catalog([model({ tier: "pro" })])),
      /unknown key "tier"/,
    );
  });

  it("validates limits, capabilities, and status", () => {
    for (const bad of [
      { contextWindow: 0 },
      { contextWindow: 1.5 },
      { maxOutputTokens: -1 },
      { status: "retired" },
      { capabilities: { streaming: "yes" } },
      { capabilities: { telepathy: true } },
    ]) {
      assert.throws(() => validateCatalog(catalog([model(bad)])), CatalogError);
    }
    assert.throws(
      () => validateCatalog({ schemaVersion: 2, models: [] }),
      /non-empty models array/,
    );
  });

  it("reports a missing shipped catalog clearly", () => {
    assert.throws(
      () => loadCatalogSync(path.join(tempDir(), "missing.json")),
      /Model catalog not found/,
    );
  });
});

describe("model registry view", () => {
  it("queries an immutable snapshot without owning credentials", () => {
    const snapshot = {
      ...validateCatalog(
        catalog([
          model(),
          model({ id: "gemini-pro", name: "Gemini Pro" }),
          model({ provider: "openrouter", id: "deepseek/deepseek-chat", wire: "openrouter" }),
        ]),
      ),
      revision: 7,
    };
    const registry = createModelRegistry(snapshot);

    assert.equal(registry.revision, 7);
    assert.equal(registry.find("google", "gemini-test").name, "Gemini Test");
    assert.equal(registry.find("google", "missing"), undefined);
    assert.equal(registry.has("google", "gemini-pro"), true);
    assert.deepEqual(registry.providers(), ["google", "openrouter"]);
    assert.equal(registry.byProvider("google").length, 2);
    assert.deepEqual(registry.byProvider("missing"), []);
    assert.ok(Object.isFrozen(registry));
    assert.ok(Object.isFrozen(registry.models()));
  });
});

describe("revisioned catalog store", () => {
  it("keeps the last good snapshot after an invalid edit and recovers", async () => {
    const dir = tempDir();
    const filePath = path.join(dir, "models.json");
    writeCatalog(filePath, catalog());

    const store = createCatalogStore({ filePath, interval: 20 });
    const seen = [];
    const unsubscribe = store.onChange((snapshot) => seen.push(snapshot));

    const first = await store.init();
    assert.equal(first.revision, 1);
    assert.equal(first.lastError, null);
    assert.equal(store.findModel("google", "gemini-test").name, "Gemini Test");

    fs.writeFileSync(filePath, "{ not json", "utf8");
    const broken = await store.reload();
    assert.equal(broken.revision, 1, "invalid data must not bump the revision");
    assert.ok(broken.lastError);
    assert.equal(broken.lastError.code, "MODEL_CATALOG_INVALID");
    assert.equal(store.findModel("google", "gemini-test").name, "Gemini Test");

    // Restoring the same last-good bytes clears the error without a new
    // revision: nothing about the model data changed.
    writeCatalog(filePath, catalog());
    const restored = await store.reload();
    assert.equal(restored.revision, 1);
    assert.equal(restored.lastError, null);

    // A genuinely different valid catalog does bump the revision.
    writeCatalog(
      filePath,
      catalog([model({ id: "gemini-next", name: "Gemini Next" })]),
    );
    const next = await store.reload();
    assert.equal(next.revision, 2);
    assert.equal(next.lastError, null);
    assert.equal(store.findModel("google", "gemini-next").name, "Gemini Next");

    assert.ok(seen.length >= 3);
    unsubscribe();

    store.startWatcher();
    store.startWatcher();
    store.stopWatcher();
    store.stopWatcher();
  });

  it("hot-reloads a valid external edit through the watcher", async () => {
    const dir = tempDir();
    const filePath = path.join(dir, "models.json");
    writeCatalog(filePath, catalog());

    const store = createCatalogStore({
      filePath,
      interval: 20,
      debounceMs: 5,
    });
    await store.init();
    store.startWatcher();

    try {
      writeCatalog(
        filePath,
        catalog([model({ id: "gemini-watched", name: "Gemini Watched" })]),
      );
      await waitFor(() => store.getSnapshot()?.revision === 2);
      assert.equal(
        store.findModel("google", "gemini-watched").name,
        "Gemini Watched",
      );
    } finally {
      store.stopWatcher();
    }
  });

  it("does not re-read the file when an initial snapshot is supplied", async () => {
    const store = createCatalogStore({
      filePath: path.join(tempDir(), "never-read.json"),
      initial: validateCatalog(catalog()),
    });

    assert.equal(store.isInitialized(), true);
    const snapshot = await store.init();
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.source, "initial");
  });
});
