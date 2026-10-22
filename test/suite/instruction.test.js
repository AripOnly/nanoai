// test/suite/instruction.test.js
// Offline. createInstruction must load known prompts and reject bad names
// with clear messages instead of raw filesystem errors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInstruction } from "../../src/prompts/createInstruction.js";

describe("createInstruction", () => {
  it("loads the default, plan, and explore instructions", async () => {
    for (const name of ["default", "plan", "explore"]) {
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

  it("adds bounded skill catalog, auto-load, and hint sections", async () => {
    const text = await createInstruction("default", {
      username: "tester",
      skillCatalog:
        "<available_skills>\n- pdf-report: Build a PDF. [trust: external]\n</available_skills>",
      skillAutoLoad:
        '<skill name="pdf-report" trust="user-approved">body</skill>',
      skillHints: ["email-writer", "", "pdf-report", "extra", "fourth"],
    });
    assert.match(text, /# Skills/);
    assert.match(text, /available_skills/);
    assert.match(text, /supplementary prompt content/);
    assert.match(text, /Never execute a skill's scripts/);
    assert.match(text, /# Auto-loaded skill/);
    assert.match(text, /<skill name="pdf-report"/);
    assert.match(text, /# Skill hints/);
    assert.match(text, /- email-writer/);
    assert.match(text, /- pdf-report/);
    assert.match(text, /- extra/);
    assert.equal(text.includes("- fourth"), false);
    assert.equal(text.includes("install/update/remove skills"), true);
  });

  it("omits skill sections when no skill data is supplied", async () => {
    const text = await createInstruction("default");
    assert.equal(text.includes("# Skills"), false);
    assert.equal(text.includes("# Auto-loaded skill"), false);
    assert.equal(text.includes("# Skill hints"), false);
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
