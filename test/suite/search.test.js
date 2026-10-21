// test/suite/search.test.js
// Covers the glob/grep tools: happy paths, empty results, invalid regex,
// input validation, and searching outside the workspace (read-only tools may
// point anywhere; the jail only applies to read/write).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "../../src/tools/glob.js";
import { grep } from "../../src/tools/grep.js";
import { resolveRgBinary } from "../../src/tools/shared/rg.js";
import { toolExecute } from "../../src/tools/executor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Absolute on purpose: relative tool paths anchor at the workspace root
// (home), not at the test runner's cwd.
const TOOLS_DIR = path.join(__dirname, "..", "..", "src", "tools");

before(async () => {
  // Downloads ripgrep on first use when no system binary exists; the result
  // is cached under the per-user data dir for later runs.
  const binary = await resolveRgBinary();
  assert.ok(binary && typeof binary === "string", "expected a ripgrep binary path");
});

describe("glob tool", () => {
  it("finds files by pattern", async () => {
    const result = await glob({ pattern: "*.js", path: TOOLS_DIR });
    assert.equal(result.success, true);
    assert.ok(result.count > 0, "expected at least one match");
    assert.equal(result.truncated, false);
    assert.ok(
      result.output.split("\n").some((line) => line.endsWith("glob.js")),
      `expected glob.js in output:\n${result.output.slice(0, 300)}`,
    );
  });

  it("reports empty results clearly", async () => {
    const result = await glob({ pattern: "*.nonexistent-ext-xyz", path: TOOLS_DIR });
    assert.equal(result.success, true);
    assert.match(result.output, /No files found in /);
    assert.ok(result.output.includes(TOOLS_DIR));
    assert.equal(result.count, 0);
  });

  it("validates its inputs", async () => {
    assert.equal((await glob()).success, false);
    assert.equal((await glob({})).success, false);
    assert.equal((await glob({ pattern: "   " })).success, false);
    assert.equal((await glob({ pattern: "*.js", path: "   " })).success, false);
    assert.equal((await glob("*.js")).success, false);
    // A file is not a searchable directory.
    const fileAsDir = await glob({ pattern: "*", path: path.join(TOOLS_DIR, "glob.js") });
    assert.equal(fileAsDir.success, false);
    assert.match(fileAsDir.error, /directory/);
    // Missing directories fail with a clear message.
    const missing = await glob({ pattern: "*", path: path.join(TOOLS_DIR, "nope-missing") });
    assert.equal(missing.success, false);
    assert.match(missing.error, /does not exist/);
  });
});

describe("grep tool", () => {
  it("finds content matches grouped by file", async () => {
    const result = await grep({ pattern: "resolveWorkspaceRoot", path: TOOLS_DIR, include: "*.js" });
    assert.equal(result.success, true);
    assert.ok(result.matches > 0, "expected at least one match");
    assert.ok(result.output.includes("Found"), result.output.slice(0, 120));
    assert.ok(result.output.includes("Line "), result.output.slice(0, 400));
  });

  it("searches a single file path", async () => {
    const result = await grep({ pattern: "pattern", path: path.join(TOOLS_DIR, "glob.js") });
    assert.equal(result.success, true);
    assert.ok(result.matches > 0, "expected matches inside glob.js");
  });

  it("searches outside the workspace", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nano-grep-"));
    const file = path.join(dir, "note.txt");
    fs.writeFileSync(file, "first line\nneedle in a haystack\nlast line\n", "utf8");
    try {
      const result = await grep({ pattern: "needle", path: file });
      assert.equal(result.success, true);
      assert.equal(result.matches, 1);
      assert.ok(result.output.includes("Line 2"), result.output);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports empty results clearly", async () => {
    const result = await grep({ pattern: "zzz-no-match-xyz-123", path: TOOLS_DIR });
    assert.equal(result.success, true);
    assert.match(result.output, /No files found in /);
    assert.ok(result.output.includes(TOOLS_DIR));
    assert.equal(result.matches, 0);
  });

  it("rejects invalid regex with a clear message", async () => {
    const result = await grep({ pattern: "(", path: TOOLS_DIR });
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid regex pattern/);
  });

  it("validates its inputs", async () => {
    assert.equal((await grep()).success, false);
    assert.equal((await grep({})).success, false);
    assert.equal((await grep({ pattern: "" })).success, false);
    assert.equal((await grep({ pattern: "x", path: "" })).success, false);
    assert.equal((await grep({ pattern: "x", include: "" })).success, false);
    assert.equal((await grep({ pattern: "x", path: path.join(TOOLS_DIR, "nope-missing") })).success, false);
    assert.equal((await grep("pattern")).success, false);
  });
});

describe("search tools via toolExecute", () => {
  it("dispatches glob and grep by name", async () => {
    const globResult = await toolExecute({
      name: "glob",
      arguments: { pattern: "*.js", path: TOOLS_DIR },
    });
    assert.equal(globResult.success, true);
    assert.ok(globResult.count > 0);

    const grepResult = await toolExecute({
      name: "grep",
      arguments: JSON.stringify({ pattern: "resolveWorkspaceRoot", path: TOOLS_DIR, include: "*.js" }),
    });
    assert.equal(grepResult.success, true);
    assert.ok(grepResult.matches > 0);
  });
});
