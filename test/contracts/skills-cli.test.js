// test/contracts/skills-cli.test.js
//
// The CLI is an explicit, out-of-band entry point: interactive installs may
// rely on a confirmation prompt, while non-interactive installs must carry
// --trust user-approved. These tests stop before the installer/network path.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanoai-skills-cli-"));

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function runSkills(args) {
  return spawnSync(
    process.execPath,
    [path.join(repoRoot, "bin", "nanoai.js"), "skills", ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NANO_DATA_DIR: dataDir,
        NANOAI_SKIP_MIGRATION: "1",
      },
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

describe("skills CLI install trust gate", () => {
  it("requires --trust for a non-interactive install", () => {
    const result = runSkills([
      "add",
      "owner/repo",
      "--skill",
      "example",
      "--yes",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires --trust user-approved/);
    assert.doesNotMatch(result.stdout, /^Source:/m);
  });

  it("rejects an invalid trust value", () => {
    const result = runSkills([
      "add",
      "owner/repo",
      "--skill",
      "example",
      "--trust",
      "signed",
      "--yes",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--trust must be user-approved/);
  });

  it("documents that --trust is optional for interactive installs", () => {
    const result = runSkills(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[--trust user-approved\]/);
    assert.match(result.stdout, /nanoai skills add <path>/);
    assert.match(result.stdout, /With --yes, --trust user-approved is required/);
  });

  it("prints help for a subcommand instead of starting an install", () => {
    const result = runSkills(["add", "--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
    assert.doesNotMatch(result.stdout, /^Source:/m);
  });
});
