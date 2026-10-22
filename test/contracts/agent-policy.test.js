// test/contracts/agent-policy.test.js
//
// Agent policy is enforced in two places: the loop only advertises each
// agent's tools, and toolExecute refuses anything outside the allowlist or
// policy envelope even if a model invents it. Workspace containment is tested
// with a real temp root, without executing shell commands.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAgent,
  hasAgent,
  listAgentNames,
} from "../../src/agents/index.js";
import { getAgentDefinition } from "../../src/agents/registry.js";
import { toolExecute } from "../../src/tools/executor.js";
import { shell } from "../../src/tools/shell/shell.js";
import { resolveWorkspacePath } from "../../src/tools/shared/workspace.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nano-policy-root-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nano-policy-outside-"));
const previousWorkspace = process.env.NANO_WORKSPACE;

before(() => {
  process.env.NANO_WORKSPACE = root;
  fs.writeFileSync(path.join(root, "inside.txt"), "inside");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
});

after(() => {
  if (previousWorkspace === undefined) {
    delete process.env.NANO_WORKSPACE;
  } else {
    process.env.NANO_WORKSPACE = previousWorkspace;
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("public agent roster and policy", () => {
  it("exposes primaries only and gives each a safety envelope", () => {
    assert.deepEqual(listAgentNames(), ["nano", "plan"]);
    assert.equal(getAgent("compaction"), undefined);
    assert.equal(hasAgent("compaction"), false);

    const plan = getAgent("plan");
    assert.equal(plan.mode, "primary");
    assert.equal(plan.policy.allowShell, false);
    assert.equal(plan.policy.allowWrite, false);
    assert.ok(plan.policy.maxSteps > 0);
    assert.ok(
      !plan.tools.includes("shell"),
      "read-only agent must not advertise shell",
    );

    const nano = getAgent("nano");
    assert.equal(nano.policy.allowShell, true);
    assert.equal(nano.policy.allowWrite, true);
  });

  it("keeps explore internal, read-only, and unable to delegate", () => {
    assert.equal(getAgent("explore"), undefined);
    assert.equal(hasAgent("explore"), false);

    const explore = getAgentDefinition("explore");
    assert.equal(explore.mode, "subagent");
    assert.equal(explore.delegatable, true);
    assert.equal(explore.policy.allowShell, false);
    assert.equal(explore.policy.allowWrite, false);
    assert.ok(!explore.tools.includes("delegate"));
    assert.ok(!explore.tools.includes("shell"));
    assert.ok(explore.tools.includes("read"));
    assert.ok(explore.tools.includes("grep"));
    assert.ok(explore.tools.includes("webSearch"));
  });
});

describe("toolExecute policy enforcement", () => {
  it("refuses a tool outside the agent allowlist", async () => {
    const result = await toolExecute(
      { name: "shell", arguments: { command: "echo nope" } },
      { allowedTools: ["read"], policy: { allowShell: true } },
    );

    assert.equal(result.success, false);
    assert.match(result.error, /not allowed for this agent/);
  });

  it("refuses shell when the policy disables it, even if listed", async () => {
    const result = await toolExecute(
      { name: "shell", arguments: { command: "echo nope" } },
      { allowedTools: ["shell"], policy: { allowShell: false } },
    );

    assert.equal(result.success, false);
    assert.match(result.error, /disabled by the agent policy/);
  });

  it("refuses mutating tools when allowWrite is false", async () => {
    const target = path.join(root, "blocked.txt");
    const result = await toolExecute(
      {
        name: "write",
        arguments: { filePath: target, content: "should not exist" },
      },
      { allowedTools: ["write"], policy: { allowWrite: false } },
    );

    assert.equal(result.success, false);
    assert.match(result.error, /disabled by the agent policy/);
    assert.equal(fs.existsSync(target), false);
  });

  it("does not start a tool after the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await toolExecute(
      { name: "read", arguments: { path: "inside.txt" } },
      { allowedTools: ["read"], signal: controller.signal },
    );

    assert.equal(result.success, false);
    assert.match(result.error, /aborted/);
  });

  it("passes policy through to tool path resolution", async () => {
    const blocked = await toolExecute(
      {
        name: "read",
        arguments: { path: path.join(outside, "secret.txt") },
      },
      { allowedTools: ["read"], policy: { allowOutsideRoot: false } },
    );
    assert.equal(blocked.success, false);
    assert.match(blocked.error, /outside the workspace root/);

    const allowed = await toolExecute(
      { name: "read", arguments: { path: "inside.txt" } },
      { allowedTools: ["read"], policy: { allowOutsideRoot: false } },
    );
    assert.equal(allowed.success, true);
    assert.match(allowed.output, /inside/);
  });
});

describe("workspace and shell containment policy", () => {
  it("blocks absolute and ../ escapes when allowOutsideRoot is false", () => {
    assert.throws(
      () =>
        resolveWorkspacePath(path.join(outside, "secret.txt"), {
          allowOutsideRoot: false,
        }),
      /outside the workspace root/,
    );
    assert.throws(
      () => resolveWorkspacePath("../escape.txt", { allowOutsideRoot: false }),
      /outside the workspace root/,
    );
    assert.equal(
      resolveWorkspacePath("inside.txt", { allowOutsideRoot: false }),
      path.join(root, "inside.txt"),
    );
  });

  it("keeps unrestricted absolute paths when the policy allows them", () => {
    assert.equal(
      resolveWorkspacePath(path.join(outside, "secret.txt")),
      path.join(outside, "secret.txt"),
    );
  });

  it("refuses shell and outside workdirs under a confined policy", async () => {
    const disabled = await shell(
      { command: "echo nope" },
      { policy: { allowShell: false } },
    );
    assert.equal(disabled.success, false);
    assert.match(disabled.error, /disabled by the agent policy/);

    const confined = await shell(
      { command: "echo nope", workdir: outside },
      { policy: { allowShell: true, allowOutsideRoot: false } },
    );
    assert.equal(confined.success, false);
    assert.match(confined.error, /outside the workspace root/);
  });
});
