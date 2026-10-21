// test/suite/edit.test.js
// Covers the edit tool: exact/fuzzy replacement, uniqueness enforcement,
// replaceAll, new-file creation, line-ending and BOM preservation, input
// validation, workspace jail, and concurrent edits to the same file.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { edit, replace } from "../../src/tools/edit.js";
import { toolExecute } from "../../src/tools/executor.js";

let counter = 0;

function scratchDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nano-edit-"));
  // Jail the tool to the scratch dir for these tests.
  process.env.NANO_WORKSPACE = dir;
  return dir;
}

function makeFile(dir, name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf8");
  return name;
}

describe("edit tool: basic replacement", () => {
  it("replaces an exact unique match and returns a diff", async () => {
    const dir = scratchDir();
    const name = makeFile(dir, `basic-${counter++}.txt`, "hello world\nsecond line\n");
    const result = await edit({ filePath: name, oldString: "hello world", newString: "hello nano" });
    assert.equal(result.success, true);
    assert.equal(result.output, "Edit applied successfully.");
    assert.ok(result.diff.includes("hello nano"), result.diff.slice(0, 300));
    assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), "hello nano\nsecond line\n");
  });

  it("refuses identical oldString and newString", async () => {
    const dir = scratchDir();
    const name = makeFile(dir, `same-${counter++}.txt`, "abc\n");
    const result = await edit({ filePath: name, oldString: "abc", newString: "abc" });
    assert.equal(result.success, false);
    assert.match(result.error, /identical/);
  });

  it("reports a missing match clearly", async () => {
    const dir = scratchDir();
    const name = makeFile(dir, `missing-${counter++}.txt`, "abc\n");
    const result = await edit({ filePath: name, oldString: "zzz not here", newString: "x" });
    assert.equal(result.success, false);
    assert.match(result.error, /Could not find oldString/);
  });

  it("requires uniqueness without replaceAll", async () => {
    const dir = scratchDir();
    const name = makeFile(dir, `dup-${counter++}.txt`, "foo\nfoo\n");
    const result = await edit({ filePath: name, oldString: "foo", newString: "bar" });
    assert.equal(result.success, false);
    assert.match(result.error, /multiple matches/);
  });

  it("replaces all occurrences with replaceAll", async () => {
    const dir = scratchDir();
    const name = makeFile(dir, `all-${counter++}.txt`, "foo\nfoo\n");
    const result = await edit({ filePath: name, oldString: "foo", newString: "bar", replaceAll: true });
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), "bar\nbar\n");
  });
});

describe("edit tool: fuzzy matching", () => {
  it("tolerates indentation differences", async () => {
    const dir = scratchDir();
    const name = makeFile(dir, `indent-${counter++}.txt`, "if (x) {\n    doThing();\n}\n");
    const result = await edit({ filePath: name, oldString: "if (x) {\ndoThing();\n}", newString: "if (y) {\ndoThing();\n}" });
    assert.equal(result.success, true);
    assert.ok(fs.readFileSync(path.join(dir, name), "utf8").includes("if (y) {"));
  });

  it("replaces through the pure replace() function", () => {
    const out = replace("a = 1\nb = 2\n", "b = 2", "b = 3");
    assert.equal(out, "a = 1\nb = 3\n");
    assert.throws(() => replace("a\n", "a", "a"), /identical/);
    assert.throws(() => replace("a\n", "", "b"), /cannot be empty/);
    assert.throws(() => replace("a\n", "zzz", "b"), /Could not find/);
  });
});

describe("edit tool: new files and validation", () => {
  it("creates a new file with empty oldString", async () => {
    const dir = scratchDir();
    const name = `new-${counter++}.txt`;
    const result = await edit({ filePath: name, oldString: "", newString: "fresh\n" });
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), "fresh\n");
  });

  it("refuses empty oldString on existing files", async () => {
    const dir = scratchDir();
    const name = makeFile(dir, `exists-${counter++}.txt`, "data\n");
    const result = await edit({ filePath: name, oldString: "", newString: "other" });
    assert.equal(result.success, false);
    assert.match(result.error, /cannot be empty/);
  });

  it("validates every parameter", async () => {
    scratchDir();
    assert.equal((await edit()).success, false);
    assert.equal((await edit({})).success, false);
    assert.equal((await edit({ filePath: "  ", oldString: "a", newString: "b" })).success, false);
    assert.equal((await edit({ filePath: "x.txt", oldString: 42, newString: "b" })).success, false);
    assert.equal((await edit({ filePath: "x.txt", oldString: "a", newString: null })).success, false);
    assert.equal((await edit({ filePath: "x.txt", oldString: "a", newString: "b", replaceAll: "yes" })).success, false);
    assert.equal((await edit("nope")).success, false);
  });

  it("reports missing files and directories clearly", async () => {
    const dir = scratchDir();
    const missing = await edit({ filePath: "does-not-exist.txt", oldString: "a", newString: "b" });
    assert.equal(missing.success, false);
    assert.match(missing.error, /not found/);
    const isDir = await edit({ filePath: ".", oldString: "a", newString: "b" });
    assert.equal(isDir.success, false);
    assert.match(isDir.error, /directory/);
    assert.ok(dir.length > 0);
  });

  it("edits explicit absolute paths outside the workspace (user menyebut lokasi)", async () => {
    scratchDir();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nano-edit-out-"));
    try {
      const target = path.join(outside, "bebas.txt");
      fs.writeFileSync(target, "hello\n", "utf8");
      const result = await edit({ filePath: target, oldString: "hello", newString: "halo" });
      assert.equal(result.success, true);
      assert.equal(fs.readFileSync(target, "utf8"), "halo\n");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("edit tool: byte stability", () => {
  it("preserves CRLF line endings", async () => {
    const dir = scratchDir();
    const name = `crlf-${counter++}.txt`;
    fs.writeFileSync(path.join(dir, name), "one\r\ntwo\r\n", "utf8");
    const result = await edit({ filePath: name, oldString: "one", newString: "uno" });
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), "uno\r\ntwo\r\n");
  });

  it("preserves a UTF-8 BOM", async () => {
    const dir = scratchDir();
    const name = `bom-${counter++}.txt`;
    fs.writeFileSync(path.join(dir, name), "\uFEFFwith bom\n", "utf8");
    const result = await edit({ filePath: name, oldString: "with bom", newString: "still bom" });
    assert.equal(result.success, true);
    const raw = fs.readFileSync(path.join(dir, name), "utf8");
    assert.equal(raw.charCodeAt(0), 0xfeff);
    assert.ok(raw.includes("still bom"));
  });
});

describe("edit tool: concurrency and dispatch", () => {
  it("serializes concurrent edits to the same file", async () => {
    const dir = scratchDir();
    const name = makeFile(dir, `race-${counter++}.txt`, "v0\n");
    const [first, second] = await Promise.all([
      edit({ filePath: name, oldString: "v0", newString: "v1" }),
      edit({ filePath: name, oldString: "v1", newString: "v2" }),
    ]);
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), "v2\n");
  });

  it("dispatches by name through toolExecute", async () => {
    const dir = scratchDir();
    const name = makeFile(dir, `dispatch-${counter++}.txt`, "alpha\n");
    const result = await toolExecute({
      name: "edit",
      arguments: JSON.stringify({ filePath: name, oldString: "alpha", newString: "beta" }),
    });
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), "beta\n");
    assert.ok(dir.length > 0);
  });
});
