// test/suite/infra.test.js
// Fase 6 hardening primitives: structured JSON logs with rotation, the
// platform boundary, and attachment retention cleanup.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, RotatingLogWriter } from "../../src/infra/logger.js";
import {
  buildShellSpawn,
  isProcessAlive,
  killProcessTree,
  setPrivateMode,
} from "../../src/infra/platform.js";
import {
  ATTACH_DIR,
  cleanupOldAttachments,
} from "../../src/infra/attachments.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("structured logger", () => {
  it("writes JSON lines, redacts secret fields, and serializes errors", () => {
    const dir = tempDir("nano-log-");
    const file = path.join(dir, "app.log");
    const lines = [];
    const logger = createLogger({
      name: "test",
      level: "debug",
      sink: (_entry, line) => lines.push(line),
      mirror: false,
      clock: () => new Date("2026-10-22T12:00:00.000Z"),
    });

    logger.debug("debug message", { count: 2 });
    logger.info("hello", { foo: "bar", token: "secret", nested: { api_key: "x" } });
    logger.error("failed", { error: new Error("boom") });

    assert.equal(lines.length, 3);
    const first = JSON.parse(lines[0]);
    assert.equal(first.ts, "2026-10-22T12:00:00.000Z");
    assert.equal(first.level, "debug");
    assert.equal(first.name, "test");
    assert.equal(first.msg, "debug message");
    assert.equal(first.count, 2);

    const second = JSON.parse(lines[1]);
    assert.equal(second.token, "[redacted]");
    assert.equal(second.nested.api_key, "[redacted]");
    assert.equal(second.foo, "bar");

    const third = JSON.parse(lines[2]);
    assert.equal(third.error.name, "Error");
    assert.equal(third.error.message, "boom");
    assert.ok(third.error.stack.includes("boom"));

    // Sanity: the file sink is independent of the custom test sink.
    const fileLogger = createLogger({ name: "file", file, mirror: false });
    fileLogger.info("to disk", { ok: true });
    const disk = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(disk.at(-1).msg, "to disk");
    assert.equal(disk.at(-1).ok, true);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  });

  it("respects the level threshold", () => {
    const lines = [];
    const logger = createLogger({
      level: "warn",
      sink: (_entry, line) => lines.push(line),
      mirror: false,
    });
    logger.debug("hidden");
    logger.info("hidden");
    logger.warn("visible");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).level, "warn");
  });

  it("rotates files before they exceed the cap", () => {
    const dir = tempDir("nano-rotate-");
    const file = path.join(dir, "gateway.log");
    const writer = new RotatingLogWriter(file, { maxBytes: 120, keep: 2 });
    for (let index = 0; index < 10; index++) {
      writer.writeLine(JSON.stringify({ index, payload: "x".repeat(30) }));
    }
    assert.ok(fs.statSync(file).size <= 120);
    assert.ok(fs.existsSync(`${file}.1`));
    assert.ok(!fs.existsSync(`${file}.3`));
  });
});

describe("platform boundary", () => {
  it("builds shell-specific spawn arguments", () => {
    const powershell = buildShellSpawn({
      shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      command: "Get-ChildItem",
      cwd: "C:\\",
      env: {},
    });
    assert.match(powershell.args.at(-1), /Get-ChildItem/);
    assert.equal(powershell.options.detached, false);

    const cmd = buildShellSpawn({
      shell: "C:\\Windows\\System32\\cmd.exe",
      command: "dir",
      cwd: "C:\\",
      env: {},
    });
    assert.deepEqual(cmd.args.slice(0, 3), ["/d", "/s", "/c"]);

    const posix = buildShellSpawn({
      shell: "/bin/bash",
      command: "echo hi",
      cwd: "/tmp",
      env: {},
    });
    assert.equal(posix.command, "echo hi");
    assert.equal(posix.options.shell, "/bin/bash");
  });

  it("reports liveness and refuses to kill this process", async () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(0), false);
    assert.equal(isProcessAlive(-1), false);
    assert.equal(await killProcessTree(process.pid), false);
  });

  it("skips POSIX permission bits on Windows", async () => {
    const dir = tempDir("nano-mode-");
    const file = path.join(dir, "secret.json");
    fs.writeFileSync(file, "{}");
    if (process.platform === "win32") {
      assert.equal(await setPrivateMode(file), false);
    } else {
      assert.equal(await setPrivateMode(file), true);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  });
});

describe("attachment retention", () => {
  it("removes only attachments older than the window", async () => {
    fs.mkdirSync(ATTACH_DIR, { recursive: true });
    const oldFile = path.join(ATTACH_DIR, "old_attachment.png");
    const freshFile = path.join(ATTACH_DIR, "fresh_attachment.png");
    fs.writeFileSync(oldFile, "old");
    fs.writeFileSync(freshFile, "fresh");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, old, old);

    const result = await cleanupOldAttachments();
    assert.equal(result.removed >= 1, true);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(freshFile), true);
    fs.rmSync(freshFile, { force: true });
  });
});
