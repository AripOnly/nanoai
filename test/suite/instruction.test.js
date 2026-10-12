// test/suite/instruction.test.js
// Offline. createInstruction must load known prompts and reject bad names
// with clear messages instead of raw filesystem errors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInstruction } from "../../src/prompts/createInstruction.js";

describe("createInstruction", () => {
  it("loads the default and plan instructions", async () => {
    for (const name of ["default", "plan"]) {
      const text = await createInstruction(name);
      assert.ok(text.length > 1000, `${name} must have substance`);
    }
    const text = await createInstruction("default");
    assert.ok(text.length > 1000);
    assert.ok(text.includes("Username:"));
    assert.ok(text.includes("Nano"));
    assert.ok(text.includes("Conversational Approval"));
    // WorkEnv orientation must reach the model every turn: current location,
    // home directory, and the absolute-path-first strategy.
    assert.ok(text.includes("Your Current Location:"));
    assert.ok(text.includes("Home directory:"));
    assert.ok(text.includes("Prefer ABSOLUTE paths"));
  });

  it("rejects unknown, traversal, and empty names", async () => {
    await assert.rejects(
      createInstruction("nope"),
      /Unknown instruction "nope"/,
    );
    await assert.rejects(
      createInstruction("../package"),
      /Invalid instruction name/,
    );
    await assert.rejects(
      createInstruction(""),
      /non-empty string/,
    );
  });
});
