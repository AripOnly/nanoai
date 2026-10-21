// test/contracts/tool-contract.test.js
//
// Locks the single tool manifest: every tool has a schema, execute function,
// and declarative capabilities; schema selection is explicit; the executor
// normalizes timeout failures.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_DEFINITIONS,
  createToolRegistry,
  toolRegistry,
} from "../../src/tools/registry.js";
import { assertToolContract } from "../../src/tools/contract.js";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  executeTool,
  withTimeout,
} from "../../src/tools/executor.js";

function definition(overrides = {}) {
  return {
    name: "fake",
    schema: { type: "function", name: "fake", description: "fake" },
    capabilities: { fs: false, net: false, shell: false },
    execute() {
      return { success: true };
    },
    ...overrides,
  };
}

describe("tool manifest", () => {
  it("gives every registered tool a schema, execute, and capabilities", () => {
    assert.ok(TOOL_DEFINITIONS.length > 0);
    for (const tool of TOOL_DEFINITIONS) {
      assert.equal(assertToolContract(tool), tool);
      assert.equal(typeof tool.name, "string");
      assert.equal(typeof tool.execute, "function");
      assert.equal(typeof tool.schema, "object");
      assert.equal(typeof tool.capabilities, "object");
      assert.equal(tool.schema.name, tool.name);
    }
    assert.deepEqual(toolRegistry.names(), TOOL_DEFINITIONS.map((tool) => tool.name));
  });

  it("validates the tool definition shape strictly", () => {
    assert.throws(() => assertToolContract(null), /must be an object/);
    assert.throws(() => assertToolContract(definition({ name: "" })), /non-empty string/);
    assert.throws(() => assertToolContract(definition({ schema: undefined })), /schema/);
    assert.throws(() => assertToolContract(definition({ execute: undefined })), /execute/);
    assert.throws(
      () => assertToolContract(definition({ capabilities: { telepathy: true } })),
      /unknown capability/,
    );
    assert.throws(
      () => assertToolContract(definition({ capabilities: { fs: "execute" } })),
      /capability "fs"/,
    );
    assert.throws(
      () => assertToolContract(definition({ capabilities: { net: "yes" } })),
      /capability "net"/,
    );
    assert.throws(
      () => assertToolContract(definition({ timeoutMs: 0 })),
      /timeoutMs/,
    );
  });

  it("selects schemas in the requested order and rejects unknown names", () => {
    assert.deepEqual(
      toolRegistry.schemasFor(["shell", "read", "read"]).map((tool) => tool.name),
      ["shell", "read"],
    );
    assert.equal(toolRegistry.schemasFor().length, TOOL_DEFINITIONS.length);
    assert.throws(
      () => toolRegistry.schemasFor(["read", "telepathy"]),
      /Unknown tool\(s\): telepathy/,
    );
    assert.throws(
      () => createToolRegistry([definition(), definition()]),
      /Duplicate tool definition/,
    );
  });

  it("keeps an explicit default timeout and normalizes timeout results", async () => {
    assert.equal(DEFAULT_TOOL_TIMEOUT_MS, 120_000);

    const slow = new Promise((resolve) => {
      setTimeout(() => resolve({ success: true, output: "late" }), 100);
    });
    const timedOut = await withTimeout(slow, 5, "slow");
    assert.deepEqual(timedOut, {
      success: false,
      error: 'Tool "slow" timed out after 5ms.',
    });

    const fast = await withTimeout(
      Promise.resolve({ success: true, output: "ok" }),
      100,
      "fast",
    );
    assert.deepEqual(fast, { success: true, output: "ok" });
  });

  it("dispatches unknown tools and bad arguments through one error shape", async () => {
    const unknown = await executeTool({ name: "telepathy", arguments: {} });
    assert.equal(unknown.success, false);
    assert.match(unknown.error, /Tool "telepathy" not found/);

    const badJson = await executeTool({ name: "read", arguments: "{nope" });
    assert.equal(badJson.success, false);
    assert.match(badJson.error, /invalid arguments/);
  });
});
