// test/suite/tool-call-id.test.js
// Opencode-style: 1 baris per tool call, result menempel di tempat via ID
// yang dinormalisasi (call_id/callId). Tidak boleh ada orphan ganda.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCallId } from "../../src/shared/call-id.js";
import { attachToolResults } from "../../apps/cli/lib/tool-display.js";

describe("getCallId", () => {
  it("reads call_id, falls back to callId", () => {
    assert.equal(getCallId({ call_id: "a" }), "a");
    assert.equal(getCallId({ callId: "b" }), "b");
    assert.equal(getCallId({ call_id: "a", callId: "b" }), "a");
    assert.equal(getCallId(null), undefined);
    assert.equal(getCallId("x"), undefined);
  });
});

describe("attachToolResults (opencode-style single row)", () => {
  it("merges 2 parallel calls with their results, no orphans", () => {
    const chat = [
      { role: "tool_call", content: { call_id: "a", name: "read", arguments: {} } },
      { role: "tool_call", content: { call_id: "b", name: "shell", arguments: {} } },
      { role: "tool_result", content: { call_id: "a", result: { output: "isi a" } } },
      { role: "tool_result", content: { call_id: "b", result: { output: "git ok" } } },
    ];
    const merged = attachToolResults(chat);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].content.result.output, "isi a");
    assert.equal(merged[1].content.result.output, "git ok");
  });

  it("merges a camelCase callId result into its snake_case call", () => {
    const chat = [
      { role: "tool_call", content: { call_id: "a", name: "shell", arguments: {} } },
      { role: "tool_result", content: { callId: "a", name: "shell", result: { output: "nyasar" } } },
    ];
    const merged = attachToolResults(chat);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].role, "tool_call");
    assert.equal(merged[0].content.result.output, "nyasar");
  });

  it("keeps result order independent (result b before result a)", () => {
    const chat = [
      { role: "tool_call", content: { call_id: "a", name: "read", arguments: {} } },
      { role: "tool_call", content: { call_id: "b", name: "shell", arguments: {} } },
      { role: "tool_result", content: { call_id: "b", result: { output: "B" } } },
      { role: "tool_result", content: { call_id: "a", result: { output: "A" } } },
    ];
    const merged = attachToolResults(chat);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].content.result.output, "A");
    assert.equal(merged[1].content.result.output, "B");
  });

  it("keeps item identity when nothing merges (no wasted re-render)", () => {
    const call = { role: "tool_call", content: { call_id: "a", name: "read" } };
    const chat = [call];
    const merged = attachToolResults(chat);
    assert.equal(merged.length, 1);
    assert.equal(merged[0], call);
  });

  it("keeps genuine orphans as-is", () => {
    const ghost = { role: "tool_result", content: { call_id: "ghost", result: { output: "?" } } };
    const merged = attachToolResults([{ role: "tool_call", content: { call_id: "a" } }, ghost]);
    assert.equal(merged.length, 2);
    assert.equal(merged[1], ghost);
  });
});
