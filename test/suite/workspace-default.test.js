// test/suite/workspace-default.test.js
// Opsi A: start in home, default save to nano-workspace when no path mentioned.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceRoot, resolveHomeDir } from "../../src/tools/shared/workspace.js";
import { getWorkEnv } from "../../src/prompts/workEnv.js";
import { shell } from "../../src/tools/shell/shell.js";
import { write } from "../../src/tools/write/write.js";
import { read } from "../../src/tools/read/read.js";

describe("workspace default (Opsi A)", () => {
  it("starts in home but saves to nano-workspace by default", () => {
    const home = os.homedir();
    assert.equal(resolveHomeDir(), home);
    const env = getWorkEnv();
    assert.ok(env.includes(`Your Current Location: ${home}`));
    assert.ok(env.includes("Default save location:"));
    assert.ok(env.includes("nano-workspace"));
    assert.ok(env.includes("When the user does NOT mention a path"));
  });

  it("resolves the default save root to ~/nano-workspace without env", () => {
    const prev = process.env.NANO_WORKSPACE;
    delete process.env.NANO_WORKSPACE;
    try {
      assert.equal(resolveWorkspaceRoot(), path.join(os.homedir(), "nano-workspace"));
    } finally {
      if (prev === undefined) delete process.env.NANO_WORKSPACE;
      else process.env.NANO_WORKSPACE = prev;
    }
  });

  it("shell defaults to home (tanpa workdir)", async () => {
    const result = await shell({ command: "echo hi" });
    assert.equal(result.cwd, os.homedir());
    assert.ok(String(result.output ?? "").includes("hi"));
  });

  it("write/read tanpa path masuk ke NANO_WORKSPACE", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nano-ws-"));
    const prev = process.env.NANO_WORKSPACE;
    process.env.NANO_WORKSPACE = dir;
    try {
      const w1 = await write({ filePath: "catatan.txt", content: "halo" });
      assert.equal(w1.success, true);
      assert.ok(fs.existsSync(path.join(dir, "catatan.txt")));

      const w2 = await write({ filePath: "docs/a.txt", content: "isi" });
      assert.equal(w2.success, true);
      assert.ok(fs.existsSync(path.join(dir, "docs", "a.txt")));

      const r = await read({ path: "catatan.txt" });
      assert.equal(r.success, true);
      assert.ok(r.output.includes("halo"));
    } finally {
      if (prev === undefined) delete process.env.NANO_WORKSPACE;
      else process.env.NANO_WORKSPACE = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
