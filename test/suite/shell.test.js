// test/suite/shell.test.js
// Locks the shell tool contract: every failure leaves as { success: false,
// error } (never a throw) and success carries { success: true, output }.
// The one real command is a local echo — no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { shell } from "../../src/tools/shell/shell.js";

const MISSING_DIR = path.join(os.tmpdir(), "nanoai-missing-dir-xyz", "nope");

describe("shell tool contract", () => {
  it("returns fail envelopes for invalid input instead of throwing", async () => {
    assert.equal((await shell()).success, false);
    assert.equal((await shell({ command: "   " })).success, false);

    const badTimeout = await shell({ command: "echo hi", timeout: -1 });
    assert.equal(badTimeout.success, false);
    assert.match(badTimeout.error, /timeout/);

    const badCwd = await shell({ command: "echo hi", workdir: MISSING_DIR });
    assert.equal(badCwd.success, false);
    assert.match(badCwd.error, /workdir/);
  });

  it("blocks catastrophic commands with success:false and blocked:true", async () => {
    const result = await shell({ command: "format C:" });
    assert.equal(result.success, false);
    assert.equal(result.blocked, true);
    assert.match(result.error, /Blocked by safety policy/);
  });

  it("returns success:true with output for a real command", async () => {
    const result = await shell({
      command: "echo nanoai-shell-contract",
      timeout: 60_000,
    });
    assert.equal(result.success, true);
    assert.match(result.output, /nanoai-shell-contract/);
    assert.equal(typeof result.exitCode, "number");
  });
});
