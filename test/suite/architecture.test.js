// test/suite/architecture.test.js
// Fitness functions for the import contracts in ARCHITECTURE.md (once written)
// and the agreed rules: cross-folder imports use the #src alias, sibling
// tool folders never import each other, shared/ is the only shared owner.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "..", "src");

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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

describe("import contracts", () => {
  it("uses #src alias for cross-folder imports (single documented exception)", async () => {
    const offenders = [];
    for (const file of collect(SRC)) {
      for (const spec of importsOf(file)) {
        if (!spec.startsWith("../") && !spec.startsWith("../../")) continue;
        const relative = path.relative(SRC, file);
        // Root-level model catalog: the only legitimate escape above src/.
        const allowed = relative === path.join("llm", "llm.js") && spec === "../../config/models.json";
        if (!allowed) offenders.push(`${relative} -> ${spec}`);
      }
    }
    assert.deepEqual(offenders, [], `parent-relative imports outside the alias:\n${offenders.join("\n")}`);
  });

  it("has no sibling tool imports (shared/ owns shared code)", () => {
    const offenders = [];
    for (const file of collect(path.join(SRC, "tools"))) {
      for (const spec of importsOf(file)) {
        if (/tools\/read\/media/.test(spec)) {
          offenders.push(`${path.relative(SRC, file)} imports read/media (${spec})`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("declares the #src alias in package.json", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
    assert.equal(pkg.imports?.["#src/*"], "./src/*");
  });

  it("exposes the shared barrel with its contract", async () => {
    const shared = await import("../../src/tools/shared/index.js");
    for (const name of [
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
