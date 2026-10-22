// test/suite/daemon.test.js
// Crash-restart behavior is tested with fake children: the real daemon must
// never start a second gateway inside the test process.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemon, restartDelay } from "../../gateway/daemon.js";
import { createLogger } from "../../src/infra/logger.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    child.signalCode = signal ?? "SIGTERM";
    child.emit("exit", null, child.signalCode);
    return true;
  };
  return child;
}

describe("daemon restart policy", () => {
  it("uses exponential backoff with a ceiling", () => {
    assert.equal(restartDelay(1, { baseMs: 100, maxMs: 250 }), 100);
    assert.equal(restartDelay(2, { baseMs: 100, maxMs: 250 }), 200);
    assert.equal(restartDelay(3, { baseMs: 100, maxMs: 250 }), 250);
    assert.equal(restartDelay(100, { baseMs: 100, maxMs: 250 }), 250);
  });

  it("restarts after a crash and stops deterministically", async () => {
    const dir = tempDir("nano-daemon-");
    const events = [];
    let spawns = 0;
    let secondChild = null;

    const daemon = createDaemon({
      repoRoot: dir,
      entry: path.join(dir, "fake-entry.js"),
      env: { NANO_DATA_DIR: dir, PATH: process.env.PATH },
      logFile: path.join(dir, "logs", "gateway.log"),
      childPidFile: path.join(dir, "gateway.child.pid"),
      stopFile: path.join(dir, "gateway.stop"),
      logger: createLogger({
        name: "daemon-test",
        sink: (entry) => events.push(entry),
        mirror: false,
      }),
      spawnFn: () => {
        spawns += 1;
        if (spawns === 1) {
          const child = fakeChild(900001);
          setImmediate(() => {
            child.exitCode = 1;
            child.emit("exit", 1, null);
          });
          return child;
        }
        secondChild = fakeChild(900002);
        return secondChild;
      },
      restartBaseMs: 10,
      restartMaxMs: 20,
      stableMs: 0,
      shutdownTimeoutMs: 50,
      killTree: async () => true,
      handleSignals: false,
      pollMs: 20,
    });

    const done = daemon.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(spawns >= 2, `expected a restart, saw ${spawns} spawn(s)`);
    assert.ok(events.some((entry) => entry.event === "gateway.daemon.restart"));

    const code = await daemon.stop("test-stop", { code: 0 });
    assert.equal(code, 0);
    await done;
    assert.equal(fs.existsSync(path.join(dir, "gateway.stop")), false);
    assert.equal(fs.existsSync(path.join(dir, "gateway.child.pid")), false);
  });
});
