// test/suite/console.test.js
// Covers the `nano` command surface without touching the real gateway:
// argument parsing plus detached start/stop/restart/status/log against real
// stub processes and a stub /health endpoint (all inside temp directories).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  createSupervisor,
  dashboardUrl,
  helpText,
  isAlive,
  logFileFor,
  parseArgs,
  pidFileFor,
} from "../../apps/console/lib/supervisor.js";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nanoai-console-"));
}

function useTempDataDir(dir) {
  process.env.NANO_DATA_DIR = dir;
}

function stubServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

describe("nanoai argument parsing", () => {
  it("maps flags, bare calls and subcommands", () => {
    assert.deepEqual(parseArgs([]), { name: "help", args: [] });
    assert.deepEqual(parseArgs(["-h"]), { name: "help", args: [] });
    assert.deepEqual(parseArgs(["--help"]), { name: "help", args: [] });
    assert.deepEqual(parseArgs(["-v"]).name, "version");
    assert.deepEqual(parseArgs(["gateway", "start"]), { name: "gateway:start", args: [] });
    assert.deepEqual(parseArgs(["gateway", "log", "50"]), { name: "gateway:log", args: ["50"] });
    assert.deepEqual(parseArgs(["cli"]), { name: "cli", args: [] });
    assert.deepEqual(parseArgs(["web"]), { name: "web", args: [] });
    assert.deepEqual(parseArgs(["frobnicate"]), { name: "unknown", args: ["frobnicate"], raw: "frobnicate" });
    assert.deepEqual(parseArgs(["gateway", "dance"]), { name: "unknown", args: ["gateway", "dance"], raw: "gateway dance" });
  });

  it("documents every command in help", () => {
    const help = helpText();
    assert.ok(help.includes("nanoai"), "help must name the nanoai command");
    for (const word of ["gateway start", "gateway stop", "gateway restart", "gateway status", "gateway log", "cli", "web", "--help"]) {
      assert.ok(help.includes(word), `help must mention: ${word}`);
    }
    assert.ok(dashboardUrl(3060).includes("3060"));
  });
});

describe("gateway supervision (detached)", () => {
  it("starts, reports status, tails logs and stops a real child", async () => {
    const { server, port } = await stubServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "test" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const repoRoot = tempRoot();
    useTempDataDir(repoRoot);
    // Sleep stub instead of the real gateway: same detached mechanics.
    const sleeper = createSupervisor({
      repoRoot,
      port,
      spawnFn: (command, args, options) => spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000);"], options),
    });
    try {
      const started = await sleeper.start({ timeoutMs: 10000 });
      assert.equal(started.ok, true);
      assert.match(started.message, /Web: http:\/\/localhost:/);
      assert.ok(fs.statSync(pidFileFor(), { throwIfNoEntry: false })?.isFile());
      assert.equal(isAlive(Number.parseInt(fs.readFileSync(pidFileFor(), "utf8"), 10)), true);
      const status = await sleeper.status();
      assert.equal(status.running, true);
      assert.equal(typeof status.pid, "number");
      fs.writeFileSync(logFileFor(), "line one\nline two\n", { flag: "a" });
      assert.ok(sleeper.logTail(5).includes("line two"));
      const doubleStart = await sleeper.start({ timeoutMs: 1000 });
      assert.equal(doubleStart.ok, false);
      assert.match(doubleStart.message, /already running/);
      const stopped = await sleeper.stop();
      assert.equal(stopped.ok, true);
      assert.equal(fs.existsSync(pidFileFor()), false);
      const again = await sleeper.stop();
      assert.equal(again.ok, false);
    } finally {
      try {
        const pid = Number.parseInt(fs.readFileSync(pidFileFor(), "utf8"), 10);
        if (Number.isInteger(pid)) {
          try {
            process.kill(pid);
          } catch {}
        }
      } catch {}
      try {
        fs.rmSync(pidFileFor(), { force: true });
      } catch {}
      server.close();
    }
  });

  it("cleans stale pidfiles instead of trusting them", async () => {
    const repoRoot = tempRoot();
    useTempDataDir(repoRoot);
    fs.writeFileSync(pidFileFor(), "999999999", "utf8");
    const supervisor = createSupervisor({ repoRoot, port: 3060 });
    const status = await supervisor.status();
    assert.equal(status.running, false);
    assert.equal(fs.existsSync(pidFileFor()), false);
  });

  it("reports unhealthy processes honestly", async () => {
    const { server, port } = await stubServer((req, res) => {
      res.writeHead(500);
      res.end();
    });
    const repoRoot = tempRoot();
    useTempDataDir(repoRoot);
    fs.writeFileSync(pidFileFor(), String(process.pid), "utf8");
    const supervisor = createSupervisor({ repoRoot, port });
    try {
      const status = await supervisor.status();
      assert.equal(status.running, true);
      assert.match(status.message, /unhealthy|not answering/);
    } finally {
      try {
        fs.rmSync(pidFileFor(), { force: true });
      } catch {}
      server.close();
    }
  });
});
