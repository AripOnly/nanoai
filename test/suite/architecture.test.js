// test/suite/architecture.test.js
// Fitness functions for the modular-monolith import contracts.
// See: ARCHITECTURE.md + .opencode/plan/nanoai-modular-monolith.md
//
// Rules enforced here:
// 1. Cross-folder imports inside src/ use the #src alias.
// 2. Sibling tool families never import each other directly — shared code
//    lives in tools/shared/ and is reached through its barrel. The root-level
//    manifest/composition files (tools.js, registry.js, executor.js,
//    contract.js) are the deliberate exception: they compose every family.
// 3. Nobody outside src/llm/ reaches into llm/providers/* — providers are
//    used through the registry window (getProvider / llm.js) only.
// 4. apps/ and bin/ may only touch src/shared/* and src/config/*, always
//    through the #src alias (they are doors, not the engine).
// 5. The shared barrel exports its contract.
// 6. gateway/ (the HTTP door) reaches src/ only through module doors:
//    providers via src/llm/registry.js, sessions via src/session/index.js,
//    agents via src/agents/index.js — never their internals.
// 7. Fase 2 core boundaries: the agent loop is pure (no settings, session,
//    provider registry, or tool implementation imports); model metadata has no
//    SDK/settings edge; provider adapters never read settings.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");
const TOOLS = path.join(SRC, "tools");
const PROVIDERS = path.join(SRC, "llm", "providers");

function collect(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function importsOf(file) {
  const text = fs.readFileSync(file, "utf8");
  const specs = new Set();
  for (const m of text.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm)) specs.add(m[1]);
  for (const m of text.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.add(m[1]);
  return [...specs];
}

// Resolve an import spec to an absolute path when possible.
// Returns null for bare package imports (react, express, …).
function resolveSpec(file, spec) {
  if (spec.startsWith("#src/")) return path.join(SRC, spec.slice("#src/".length));
  if (spec.startsWith(".")) return path.resolve(path.dirname(file), spec);
  return null;
}

describe("import contracts", () => {
  it("uses #src alias for cross-folder imports", async () => {
    const offenders = [];
    for (const file of collect(SRC)) {
      for (const spec of importsOf(file)) {
        if (!spec.startsWith("../") && !spec.startsWith("../../")) continue;
        const relative = path.relative(SRC, file);
        offenders.push(`${relative} -> ${spec}`);
      }
    }
    assert.deepEqual(offenders, [], `parent-relative imports outside the alias:\n${offenders.join("\n")}`);
  });

  it("has no sibling tool imports (shared/ owns shared code)", () => {
    const offenders = [];
    const composition = new Set([
      "tools.js",
      "registry.js",
      "executor.js",
      "contract.js",
    ]);
    for (const file of collect(TOOLS)) {
      const rel = path.relative(TOOLS, file);
      // Family = first folder under tools/, or the file itself for the
      // root-level single-module tools (edit.js, glob.js, grep.js).
      const familyOf = (r) => (r.includes(path.sep) ? r.split(path.sep)[0] : r);
      const family = familyOf(rel);
      // Root composition files wire every family, and shared/ owns cross-
      // family code — both are exempt as importers.
      if (composition.has(rel) || family === "shared") continue;
      for (const spec of importsOf(file)) {
        const target = resolveSpec(file, spec);
        if (!target) continue;
        const targetRel = path.relative(TOOLS, target);
        if (targetRel.startsWith("..") || targetRel === "") continue;
        const targetFamily = familyOf(targetRel);
        if (targetFamily !== "shared" && targetFamily !== family) {
          offenders.push(`${rel} reaches into sibling family ${targetFamily} (${spec})`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("reaches LLM providers only through the registry window", () => {
    const offenders = [];
    for (const file of collect(SRC)) {
      if (file.startsWith(PROVIDERS + path.sep)) continue;
      if (file === path.join(SRC, "llm", "registry.js")) continue;
      for (const spec of importsOf(file)) {
        if (spec.includes("llm/providers")) {
          offenders.push(`${path.relative(SRC, file)} imports provider internals (${spec})`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("keeps apps/ and bin/ on the allowlist (shared + config via #src only)", () => {
    const offenders = [];
    const roots = [path.join(ROOT, "apps"), path.join(ROOT, "bin"), path.join(ROOT, "app.jsx")];
    const files = [];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      if (fs.statSync(root).isFile()) files.push(root);
      else files.push(...collect(root));
    }
    for (const file of files) {
      for (const spec of importsOf(file)) {
        if (spec.startsWith("#src/")) {
          const ok = spec.startsWith("#src/shared/") || spec.startsWith("#src/config/");
          if (!ok) offenders.push(`${path.relative(ROOT, file)} touches non-shared src (${spec})`);
          continue;
        }
        const target = resolveSpec(file, spec);
        if (target && !path.relative(SRC, target).startsWith("..")) {
          offenders.push(`${path.relative(ROOT, file)} enters src/ without the alias (${spec})`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("declares the #src alias in package.json", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.imports?.["#src/*"], "./src/*");
  });

  it("exposes the shared barrel with its contract", async () => {
    const shared = await import("../../src/tools/shared/index.js");
    for (const name of [
      "fail",
      "trimDiff",
      "saveAttachment",
      "loadAttachment",
      "truncateOutput",
      "rgGlob",
      "rgGrep",
      "resolveWorkspaceRoot",
      "resolveWorkspacePath",
      "suggestSimilarPaths",
    ]) {
      assert.equal(typeof shared[name], "function", `shared barrel must export ${name}`);
    }
  });
});

describe("gateway import contracts", () => {
  it("reaches providers, sessions, and agents only through their doors", () => {
    const offenders = [];
    const GATEWAY = path.join(ROOT, "gateway");
    const AGENTS_DIR = path.join(SRC, "agents");
    const AGENTS_DOOR = path.join(AGENTS_DIR, "index.js");
    const SESSION_DIR = path.join(SRC, "session");
    const SESSION_DOOR = path.join(SESSION_DIR, "index.js");
    const MODELS_DIR = path.join(SRC, "models");
    const MODELS_DOOR = path.join(MODELS_DIR, "index.js");
    const RUNTIME_DIR = path.join(SRC, "runtime");
    const RUNTIME_DOOR = path.join(RUNTIME_DIR, "index.js");
    for (const file of collect(GATEWAY)) {
      const rel = path.relative(ROOT, file);
      for (const spec of importsOf(file)) {
        const target = resolveSpec(file, spec);
        if (!target) continue;
        if (target.startsWith(PROVIDERS + path.sep)) {
          offenders.push(`${rel} imports provider internals (${spec}) — use src/llm/registry.js`);
          continue;
        }
        if (target.startsWith(SESSION_DIR + path.sep) && target !== SESSION_DOOR) {
          offenders.push(`${rel} reaches into session internals (${spec}) — use src/session/index.js`);
          continue;
        }
        if (target.startsWith(AGENTS_DIR + path.sep) && target !== AGENTS_DOOR) {
          offenders.push(`${rel} reaches into agent internals (${spec}) — use src/agents/index.js`);
          continue;
        }
        if (target.startsWith(MODELS_DIR + path.sep) && target !== MODELS_DOOR) {
          offenders.push(`${rel} reaches into model internals (${spec}) — use src/models/index.js`);
          continue;
        }
        if (target.startsWith(RUNTIME_DIR + path.sep) && target !== RUNTIME_DOOR) {
          offenders.push(`${rel} reaches into runtime internals (${spec}) — use src/runtime/index.js`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("keeps the session door a facade (named use-cases, no store object)", async () => {
    const door = await import("../../src/session/index.js");
    assert.equal(typeof door.ping, "function");
    assert.equal(door.sessionStore, undefined, "the raw store must stay private");
    for (const name of [
      "createSession",
      "listSessions",
      "getSession",
      "getSessionInfo",
      "getConversation",
      "getConversationPage",
      "listTurns",
      "getTurn",
      "findTurnByClientMessageId",
      "resolveSession",
      "renameSession",
      "deleteSession",
      "recoverInterruptedTurns",
      "recoverInterruptedTurn",
      "isSessionBusy",
      "beginTurn",
      "recordEvent",
      "commitTurn",
      "setTurnModel",
      "setSessionModel",
      "getSummary",
      "compactSession",
      "pruneConversation",
      "autoNameSession",
    ]) {
      assert.equal(typeof door[name], "function", `door must export ${name}`);
    }
    // The door names its contract; nothing else leaks through it.
    assert.deepEqual(
      Object.keys(door).sort(),
      [
        "STORAGE_DIR",
        "SessionBusyError",
        "autoNameSession",
        "beginTurn",
        "closeDatabase",
        "commitTurn",
        "compactSession",
        "createSession",
        "deleteSession",
        "findTurnByClientMessageId",
        "getConversation",
        "getConversationPage",
        "getSession",
        "getSessionInfo",
        "getSummary",
        "getTurn",
        "isSessionBusy",
        "listSessions",
        "listTurns",
        "ping",
        "pruneConversation",
        "recordEvent",
        "recoverInterruptedTurn",
        "recoverInterruptedTurns",
        "renameSession",
        "resolveSession",
        "setSessionModel",
        "setTurnModel",
      ],
    );
  });

  it("keeps the agents door a public roster (turns live in runtime)", async () => {
    const door = await import("../../src/agents/index.js");
    assert.equal(door.agent, undefined, "turn execution belongs to src/runtime");
    assert.equal(typeof door.getAgent, "function");
    assert.equal(typeof door.hasAgent, "function");
    assert.equal(typeof door.listAgentNames, "function");
    assert.equal(typeof door.toolNamesFor, "function");
    assert.ok(door.listAgentNames().includes("nano"));
    assert.equal(door.hasAgent("raksasa"), false);
    assert.equal(
      door.hasAgent("compaction"),
      false,
      "internal subagents must not be publicly addressable",
    );
    assert.equal(door.getAgent("plan").mode, "primary");
  });
});

describe("Fase 2 core boundaries", () => {
  it("keeps the agent loop free of settings, session, provider, and tool imports", () => {
    const file = path.join(SRC, "agents", "agent-loop.js");
    const specs = importsOf(file);
    for (const spec of specs) {
      assert.ok(
        spec.startsWith("#src/shared/"),
        `agent-loop.js may only depend on shared contracts, found ${spec}`,
      );
    }
  });

  it("keeps every src/agents module free of settings, session, tools, providers, and runtime", () => {
    const offenders = [];
    const AGENTS = path.join(SRC, "agents");
    const forbidden = [
      "#src/config",
      "#src/session",
      "#src/tools",
      "#src/llm",
      "#src/runtime",
      "@google/",
      "openai",
      "@anthropic",
    ];
    for (const file of collect(AGENTS)) {
      for (const spec of importsOf(file)) {
        if (forbidden.some((prefix) => spec.startsWith(prefix))) {
          offenders.push(`${path.relative(SRC, file)} -> ${spec}`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("keeps tools free of agents, sessions, runtime, and provider internals", () => {
    const offenders = [];
    for (const file of collect(TOOLS)) {
      for (const spec of importsOf(file)) {
        if (
          spec.startsWith("#src/agents") ||
          spec.startsWith("#src/session") ||
          spec.startsWith("#src/runtime") ||
          spec.startsWith("#src/llm/providers")
        ) {
          offenders.push(`${path.relative(SRC, file)} -> ${spec}`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("keeps src/llm free of agents, sessions, runtime, and tools", () => {
    const offenders = [];
    const LLM = path.join(SRC, "llm");
    for (const file of collect(LLM)) {
      for (const spec of importsOf(file)) {
        if (
          spec.startsWith("#src/agents") ||
          spec.startsWith("#src/session") ||
          spec.startsWith("#src/runtime") ||
          spec.startsWith("#src/tools")
        ) {
          offenders.push(`${path.relative(SRC, file)} -> ${spec}`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("keeps model metadata free of SDKs, settings, sessions, agents, and tools", () => {
    const offenders = [];
    const MODELS = path.join(SRC, "models");
    for (const file of collect(MODELS)) {
      for (const spec of importsOf(file)) {
        const forbidden =
          spec.startsWith("@google/") ||
          spec.startsWith("@anthropic") ||
          spec === "openai" ||
          spec.startsWith("#src/config") ||
          spec.startsWith("#src/session") ||
          spec.startsWith("#src/agents") ||
          spec.startsWith("#src/tools") ||
          spec.startsWith("#src/llm");
        if (forbidden) {
          offenders.push(`${path.relative(SRC, file)} -> ${spec}`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("keeps provider adapters settings-free", () => {
    const offenders = [];
    for (const file of collect(PROVIDERS)) {
      for (const spec of importsOf(file)) {
        if (
          spec.startsWith("#src/config") ||
          spec.startsWith("#src/session") ||
          spec.startsWith("#src/models")
        ) {
          offenders.push(`${path.relative(SRC, file)} -> ${spec}`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("keeps the provider registry model-free", async () => {
    const registry = await import("../../src/llm/registry.js");
    const google = registry.getProvider("google");
    assert.equal(google.models, undefined);
    assert.deepEqual(google.supportedWires, ["google-interactions"]);
    const specs = importsOf(path.join(SRC, "llm", "registry.js"));
    assert.ok(
      !specs.some((spec) => spec.includes("models.json") || spec.includes("/models/")),
      "provider registry must not import model metadata",
    );
  });
});
