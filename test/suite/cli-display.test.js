// test/suite/cli-display.test.js
// Covers the CLI tool-call display helpers (plain JS, no JSX): the
// "name: target" one-liner per tool plus preview trimming.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachToolResults, formatPreview, formatToolTarget } from "../../apps/cli/lib/tool-display.js";

describe("formatToolTarget", () => {
  it("shows name-relevant values per tool", () => {
    assert.equal(formatToolTarget("read", { path: "package.json" }), "package.json");
    assert.equal(formatToolTarget("write", { filePath: "src/a.txt", content: "x" }), "src/a.txt");
    assert.equal(formatToolTarget("edit", { filePath: "src/a.txt", oldString: "a", newString: "b" }), "src/a.txt");
    assert.equal(formatToolTarget("shell", { command: "git status" }), "git status");
    assert.equal(formatToolTarget("glob", { pattern: "**/*.js" }), "**/*.js");
    assert.equal(formatToolTarget("grep", { pattern: "foo" }), "foo");
    assert.equal(formatToolTarget("webSearch", { query: "latest news" }), "latest news");
    assert.equal(formatToolTarget("webFetch", { url: "https://example.com" }), "https://example.com");
    assert.equal(formatToolTarget("writeWord", { filePath: "doc.docx", blocks: [] }), "doc.docx");
    assert.equal(formatToolTarget("writeExcel", { filePath: "data.xlsx", sheets: [] }), "data.xlsx");
  });

  it("adds workdir and search-path context", () => {
    assert.equal(formatToolTarget("shell", { command: "pytest", workdir: "proj" }), "pytest @ proj");
    assert.equal(formatToolTarget("grep", { pattern: "foo", path: "src" }), "foo in src");
    assert.equal(formatToolTarget("glob", { pattern: "*.js", path: "src" }), "*.js in src");
  });

  it("accepts JSON-encoded arguments and degrades gracefully", () => {
    assert.equal(formatToolTarget("read", JSON.stringify({ path: "a.txt" })), "a.txt");
    assert.equal(formatToolTarget("shell", "echo hi"), "echo hi");
    assert.equal(formatToolTarget("read", ""), "");
    assert.equal(formatToolTarget("read", null), "");
    assert.equal(formatToolTarget("read", undefined), "");
    assert.equal(formatToolTarget("custom", { unusual: 1 }), "unusual=1");
  });

  it("single-lines and truncates long values", () => {
    assert.equal(formatToolTarget("shell", { command: "a\nb" }), "a\\nb");
    const long = formatToolTarget("read", { path: `p/${"x".repeat(100)}.txt` });
    assert.ok(long.endsWith("...") && long.length <= 63 + 3);
  });
});

describe("attachToolResults", () => {
  it("merges each result into its earlier call", () => {
    const chat = [
      { role: "tool_call", content: { call_id: "a", name: "read", arguments: { path: "x" } } },
      { role: "tool_result", content: { call_id: "a", name: "read", result: { output: "hi" } } },
      { role: "tool_call", content: { call_id: "b", name: "glob", arguments: { pattern: "*" } } },
      { role: "tool_result", content: { call_id: "b", name: "glob", result: { output: "f" } } },
    ];
    const merged = attachToolResults(chat);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].content.result.output, "hi");
    assert.equal(merged[1].content.result.output, "f");
    // Input array untouched.
    assert.equal(chat.length, 4);
    assert.equal(chat[1].role, "tool_result");
  });

  it("keeps orphans and ignores cross-order matches", () => {
    const chat = [
      { role: "tool_result", content: { call_id: "ghost", result: { output: "?" } } },
      { role: "tool_call", content: { call_id: "ghost", name: "read", arguments: {} } },
    ];
    const merged = attachToolResults(chat);
    assert.equal(merged.length, 2);
    assert.equal(merged[1].content.result, undefined);
  });

  it("passes through non-arrays", () => {
    assert.equal(attachToolResults(null), null);
    assert.deepEqual(attachToolResults([]), []);
  });
});

describe("formatPreview", () => {
  it("keeps the tail short", () => {
    assert.equal(formatPreview(null), "");
    assert.equal(formatPreview(undefined), "");
    assert.equal(formatPreview("short"), "short");
    const many = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const out = formatPreview(many);
    assert.ok(out.includes("line19") && !out.includes("line0\n"));
    const huge = "y".repeat(1000);
    assert.ok(formatPreview(huge).startsWith("...\n"));
  });
});
