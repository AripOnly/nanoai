// test/suite/jobs.test.js
//
// Fase 3.5 contract: detached jobs are durable enough to survive a gateway
// restart, pollable, bounded, session-scoped, and auto-continued at most once.
// Real child processes are used on purpose; the runner's contract with the
// gateway is the filesystem, so a mocked process would prove very little.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { dataDir } from "#src/shared/data-dir.js";
import { isProcessAlive } from "#src/jobs/kill-tree.js";
import { createJobManager } from "#src/jobs/index.js";
import { createJobNotice } from "#src/runtime/job-notice.js";
import { runTurn } from "#src/runtime/turn.js";
import * as sessionDoor from "#src/session/index.js";
import { jobStore, newJobId } from "#src/session/job-store.js";
import { EVENT } from "#src/shared/event-type.js";
import { acceptable } from "#src/tools/shell/select.js";
import { process as processTool } from "#src/tools/process/process.js";
import sessionController from "../../gateway/controllers/session-controller.js";
import {
  FAKE_MODEL,
  createFakeProvider,
  textTurn,
} from "../helpers/fake-provider.js";

const MANAGERS = [];
const NOTICES = [];
const SESSION_IDS = new Set();
const JOB_ROOT = path.join(dataDir(), "jobs");
let sequence = 0;

const TERMINAL = new Set(["completed", "failed", "killed", "lost"]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, { timeout = 10_000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }
  throw lastError ?? new Error("Timed out waiting for condition.");
}

function newSession(label = "jobs") {
  const row = sessionDoor.createSession({
    name: `${label}-${Date.now()}-${sequence++}`,
    prompt: "background job test session",
  });
  SESSION_IDS.add(row.id);
  return row.id;
}

function managerFor(jobs = {}) {
  const manager = createJobManager({
    config: () => ({ value: { jobs } }),
    logger: { info() {}, warn() {}, error() {} },
  });
  MANAGERS.push(manager);
  return manager;
}

function noticeFor(runtime, manager, extra = {}) {
  const notice = createJobNotice({
    runtime,
    jobs: manager,
    session: sessionDoor,
    busyRetryMs: 60_000,
    rateRetryMs: 60_000,
    ...extra,
  });
  NOTICES.push(notice);
  return notice;
}

function shell() {
  try {
    return acceptable();
  } catch {
    return process.platform === "win32" ? "powershell.exe" : "bash";
  }
}

function nodeCommand(script) {
  // `node` (not the absolute path) avoids PowerShell treating a quoted
  // executable path as a string expression instead of a command.
  return `node -e ${JSON.stringify(script)}`;
}

function quickCommand(text = "hello-from-job") {
  return nodeCommand(`console.log('${text}')`);
}

function failingCommand(code = 7) {
  return nodeCommand(`process.exit(${code})`);
}

function longCommand(ms = 30_000) {
  return nodeCommand(`setInterval(() => {}, 1000)`);
}

async function create(manager, sessionId, command, options = {}) {
  return manager.create({
    sessionId,
    command,
    cwd: process.cwd(),
    shell: shell(),
    notify: "always",
    ...options,
  });
}

function waitStatus(manager, sessionId, jobId, wanted, options = {}) {
  return waitFor(async () => {
    const job = await manager.poll(jobId, sessionId);
    if (wanted === "terminal") {
      return TERMINAL.has(job.status) ? job : null;
    }
    return job.status === wanted ? job : null;
  }, options);
}

function seedJob({
  sessionId,
  status = "completed",
  notify = "always",
  exitCode = 0,
  finishedAt = null,
  tail = "seeded output\n",
  active = false,
}) {
  const id = newJobId();
  const dir = path.join(JOB_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const outputPath = path.join(dir, "output.log");
  const resultPath = path.join(dir, "result.json");
  fs.writeFileSync(outputPath, tail);
  jobStore.createJob(
    {
      id,
      sessionId,
      name: "seeded job",
      command: "seed command",
      cwd: process.cwd(),
      shell: shell(),
      notify,
      timeoutMs: 10_000,
      outputPath,
      resultPath,
    },
    { maxRunning: 64, maxPerSession: 64 },
  );
  if (active) return jobStore.getJob(id);
  jobStore.finishJob(
    id,
    {
      status,
      exitCode,
      signal: null,
      timedOut: false,
      startedAt: new Date().toISOString(),
      finishedAt: finishedAt ?? new Date().toISOString(),
      outputBytes: Buffer.byteLength(tail),
      truncated: false,
      error: status === "completed" ? null : "seeded failure",
    },
    { notify: notify === "always" || (notify === "failure" && status !== "completed") },
  );
  return jobStore.getJob(id);
}

async function cleanup() {
  for (const notice of NOTICES.splice(0)) {
    try {
      await notice.dispose();
    } catch {
      // Best effort.
    }
  }
  for (const manager of MANAGERS.splice(0).reverse()) {
    for (const sessionId of SESSION_IDS) {
      try {
        await manager.killBySession(sessionId, { reason: "test cleanup" });
      } catch {
        // Best effort.
      }
    }
    manager.dispose();
  }
  for (const sessionId of SESSION_IDS) {
    try {
      sessionDoor.deleteSession(sessionId);
    } catch {
      // Already removed.
    }
  }
  SESSION_IDS.clear();
}

afterEach(cleanup);

describe("durable jobs", () => {
  it("runs detached, persists result.json, and never stores the environment", async () => {
    const manager = managerFor({ pollIntervalMs: 250 });
    const sessionId = newSession("complete");
    const secret = `secret-${Date.now()}`;
    process.env.NANO_JOB_SUITE_SECRET = secret;
    let job;
    try {
      job = await create(manager, sessionId, quickCommand("job-ok"), {
        name: "quick job",
        notify: "never",
      });
    } finally {
      delete process.env.NANO_JOB_SUITE_SECRET;
    }

    const done = await waitStatus(manager, sessionId, job.jobId, "terminal");
    assert.equal(done.status, "completed");
    assert.equal(done.exitCode, 0);
    assert.equal(done.timedOut, false);

    const output = await fsp.readFile(done.logPath, "utf8");
    assert.match(output, /job-ok/);
    const result = JSON.parse(await fsp.readFile(done.resultPath, "utf8"));
    assert.equal(result.status, "completed");

    const spec = JSON.parse(
      await fsp.readFile(path.join(JOB_ROOT, job.jobId, "spec.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(spec).sort(), [
      "command",
      "createdAt",
      "cwd",
      "jobId",
      "maxLogBytes",
      "notify",
      "outputPath",
      "resultPath",
      "shell",
      "timeoutMs",
      "version",
    ]);
    assert.ok(!JSON.stringify(spec).includes(secret), "spec must not persist env");
    assert.ok(
      !JSON.stringify(jobStore.getJob(job.jobId)).includes(secret),
      "SQLite must not persist env",
    );
    assert.equal(jobStore.getNotification(job.jobId), undefined);

    if (process.platform !== "win32") {
      const mode = (await fsp.stat(path.join(JOB_ROOT, job.jobId, "spec.json"))).mode;
      assert.equal(mode & 0o777, 0o600);
    }
  });

  it("bounds the log at maxLogBytes and marks the result truncated", async () => {
    const manager = managerFor({ maxLogBytes: 1024, pollIntervalMs: 250 });
    const sessionId = newSession("bounded");
    const job = await create(
      manager,
      sessionId,
      nodeCommand("process.stdout.write('x'.repeat(20000))"),
      { notify: "never" },
    );

    const done = await waitStatus(manager, sessionId, job.jobId, "terminal");
    assert.equal(done.status, "completed");
    assert.equal(done.truncated, true);
    const stat = await fsp.stat(done.logPath);
    assert.ok(stat.size <= 1024, `log grew to ${stat.size} bytes`);

    const result = JSON.parse(await fsp.readFile(done.resultPath, "utf8"));
    assert.equal(result.truncated, true);
    assert.equal(result.outputBytes, 1024);

    const range = await manager.log(job.jobId, sessionId, {
      offsetBytes: 0,
      limitBytes: 20,
    });
    assert.ok(range.bytesRead <= 20);
    assert.equal(range.text, "x".repeat(20));
  });

  it("retains logs by age and total size without deleting metadata", async () => {
    const manager = managerFor({
      retentionDays: 7,
      maxTotalLogBytes: 1024,
      pollIntervalMs: 250,
    });
    const sessionId = newSession("retention");
    const expired = seedJob({
      sessionId,
      notify: "never",
      finishedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      tail: "expired\n",
    });
    const older = seedJob({
      sessionId,
      notify: "never",
      finishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      tail: "a".repeat(600),
    });
    const newer = seedJob({
      sessionId,
      notify: "never",
      finishedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      tail: "b".repeat(600),
    });
    await fsp.writeFile(older.result_path, "{\"status\":\"completed\"}\n");

    const result = await manager.pruneLogs();
    assert.equal(result.removed, 2);
    assert.equal(result.remainingBytes, 600);
    await assert.rejects(fsp.access(expired.output_path));
    await assert.rejects(fsp.access(older.output_path));
    assert.equal((await fsp.stat(newer.output_path)).size, 600);
    assert.equal(await fsp.readFile(older.result_path, "utf8"), "{\"status\":\"completed\"}\n");

    // Metadata survives log retention in every case.
    assert.equal(jobStore.getJob(expired.id).status, "completed");
    assert.equal(jobStore.getJob(older.id).status, "completed");
    assert.equal(jobStore.getJob(newer.id).status, "completed");
  });

  it("rejects beyond per-session and global limits instead of queueing", async () => {
    const manager = managerFor({
      maxRunning: 2,
      maxPerSession: 1,
      pollIntervalMs: 250,
    });
    const sessionA = newSession("limit-a");
    const sessionB = newSession("limit-b");
    const sessionC = newSession("limit-c");

    const first = await create(manager, sessionA, longCommand());
    const second = await create(manager, sessionB, longCommand());
    await assert.rejects(
      create(manager, sessionA, longCommand()),
      (error) => error.code === "JOB_LIMIT",
    );
    await assert.rejects(
      create(manager, sessionC, longCommand()),
      (error) => error.code === "JOB_LIMIT",
    );

    assert.equal(jobStore.listActiveJobs().length, 2);
    await manager.kill(first.jobId, sessionA);
    await manager.kill(second.jobId, sessionB);
  });

  it("rejects new jobs when jobs.enabled is false", async () => {
    const manager = managerFor({ enabled: false });
    const sessionId = newSession("disabled");
    await assert.rejects(
      create(manager, sessionId, quickCommand("never-started")),
      (error) => error.code === "JOB_DISABLED",
    );
    assert.equal(jobStore.listJobs(sessionId).length, 0);
  });

  it("times out through the same kill path and records timedOut", async () => {
    const manager = managerFor({ pollIntervalMs: 250 });
    const sessionId = newSession("timeout");
    const job = await create(manager, sessionId, longCommand(), {
      timeoutMs: 300,
      notify: "never",
    });

    const done = await waitStatus(manager, sessionId, job.jobId, "terminal", {
      timeout: 15_000,
    });
    assert.equal(done.status, "failed");
    assert.equal(done.timedOut, true);
    assert.match(done.error, /timed out/i);
  });

  it("kills a whole process tree and is idempotent", async () => {
    const manager = managerFor({ pollIntervalMs: 250 });
    const sessionId = newSession("tree");
    const helperPath = path.join(JOB_ROOT, `tree-${Date.now()}.cjs`);
    const grandchildPidPath = path.join(JOB_ROOT, `tree-${Date.now()}.pid`);
    await fsp.mkdir(JOB_ROOT, { recursive: true });
    fs.writeFileSync(
      helperPath,
      [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "fs.writeFileSync(process.argv[2], String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const command = `node "${helperPath}" "${grandchildPidPath}"`;
    const job = await create(manager, sessionId, command, { notify: "never" });

    const grandchildPid = await waitFor(async () => {
      try {
        const pid = Number.parseInt(
          (await fsp.readFile(grandchildPidPath, "utf8")).trim(),
          10,
        );
        return Number.isInteger(pid) && pid > 0 ? pid : null;
      } catch {
        return null;
      }
    });
    assert.equal(isProcessAlive(grandchildPid), true);

    const killed = await manager.kill(job.jobId, sessionId);
    assert.equal(killed.status, "killed");
    const again = await manager.kill(job.jobId, sessionId);
    assert.equal(again.status, "killed");
    assert.equal(jobStore.getJob(job.jobId).status, "killed");
    await waitFor(() => !isProcessAlive(grandchildPid));
  });

  it("adopts a verified running job after a gateway restart", async () => {
    const first = managerFor({ pollIntervalMs: 250 });
    const sessionId = newSession("restart-running");
    const job = await create(first, sessionId, longCommand(), {
      notify: "never",
      timeoutMs: 60_000,
    });
    await waitStatus(first, sessionId, job.jobId, "running");
    const runnerPid = jobStore.getJob(job.jobId).runner_pid;
    assert.ok(Number.isInteger(runnerPid) && runnerPid > 0);
    first.dispose();

    const second = managerFor({ pollIntervalMs: 250 });
    const summary = await second.init();
    assert.ok(summary.running >= 1);
    const adopted = jobStore.getJob(job.jobId);
    assert.equal(adopted.status, "running");
    assert.equal(adopted.runner_pid, runnerPid);

    const killed = await second.kill(job.jobId, sessionId);
    assert.equal(killed.status, "killed");
  });

  it("finalizes a job that completed while the gateway was down", async () => {
    const first = managerFor({ pollIntervalMs: 250 });
    const sessionId = newSession("restart-finished");
    const job = await create(
      first,
      sessionId,
      nodeCommand("setTimeout(() => console.log('down-done'), 2500)"),
      { notify: "never", timeoutMs: 20_000 },
    );
    first.dispose();

    await waitFor(async () => {
      try {
        await fsp.access(job.resultPath);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 15_000 });

    const second = managerFor({ pollIntervalMs: 250 });
    await second.init();
    const finished = jobStore.getJob(job.jobId);
    assert.equal(finished.status, "completed");
    assert.match(await fsp.readFile(job.logPath, "utf8"), /down-done/);
  });

  it("marks a job lost when the runner is gone and result.json is absent", async () => {
    const manager = managerFor({ pollIntervalMs: 250 });
    const sessionId = newSession("lost");
    const id = newJobId();
    const dir = path.join(JOB_ROOT, id);
    fs.mkdirSync(dir, { recursive: true });
    jobStore.createJob(
      {
        id,
        sessionId,
        name: "lost job",
        command: "long gone",
        cwd: process.cwd(),
        shell: shell(),
        notify: "always",
        timeoutMs: 10_000,
        outputPath: path.join(dir, "output.log"),
        resultPath: path.join(dir, "result.json"),
      },
      { maxRunning: 64, maxPerSession: 64 },
    );

    await manager.init();
    const lost = jobStore.getJob(id);
    assert.equal(lost.status, "lost");
    assert.match(lost.error, /runner/i);
    assert.equal(jobStore.getNotification(id).state, "pending");
  });

  it("uses result.json as the source of truth during reconciliation", async () => {
    const manager = managerFor({ pollIntervalMs: 250 });
    const sessionId = newSession("result-wins");
    const notified = seedJob({ sessionId, notify: "never", active: true });
    await fsp.writeFile(
      notified.result_path,
      JSON.stringify({
        jobId: notified.id,
        status: "completed",
        exitCode: 0,
        signal: null,
        timedOut: false,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        outputBytes: 4,
        truncated: false,
        error: null,
      }),
    );

    await manager.init();
    assert.equal(jobStore.getJob(notified.id).status, "completed");
  });

  it("applies notify=never and notify=failure without inventing notices", async () => {
    const manager = managerFor({ pollIntervalMs: 250, maxPerSession: 4 });
    const sessionId = newSession("notify");
    const delivered = [];
    manager.setCompletionHandler((job) => {
      delivered.push(job.id);
    });

    const quiet = await create(manager, sessionId, quickCommand("quiet"), {
      notify: "never",
    });
    await waitStatus(manager, sessionId, quiet.jobId, "terminal");
    assert.equal(jobStore.getNotification(quiet.jobId), undefined);

    const successOnly = await create(manager, sessionId, quickCommand("ok"), {
      notify: "failure",
    });
    await waitStatus(manager, sessionId, successOnly.jobId, "terminal");
    assert.equal(jobStore.getNotification(successOnly.jobId), undefined);

    const failing = await create(manager, sessionId, failingCommand(9), {
      notify: "failure",
    });
    const done = await waitStatus(manager, sessionId, failing.jobId, "terminal");
    assert.equal(done.status, "failed");
    assert.equal(jobStore.getNotification(failing.jobId).state, "pending");
    await waitFor(() => delivered.includes(failing.jobId));
    assert.deepEqual(delivered, [failing.jobId]);
  });

  it("uses jobs.notifyDefault when the tool omits notify", async () => {
    const manager = managerFor({
      pollIntervalMs: 250,
      notifyDefault: "failure",
      maxPerSession: 4,
    });
    const sessionId = newSession("notify-default");
    const success = await create(manager, sessionId, quickCommand("default-ok"), {
      notify: undefined,
    });
    await waitStatus(manager, sessionId, success.jobId, "terminal");
    assert.equal(jobStore.getNotification(success.jobId), undefined);

    const failure = await create(manager, sessionId, failingCommand(11), {
      notify: undefined,
    });
    await waitStatus(manager, sessionId, failure.jobId, "terminal");
    assert.equal(jobStore.getNotification(failure.jobId).state, "pending");
  });

  it("scopes the process tool to the session and removes only finished logs", async () => {
    const manager = managerFor({ pollIntervalMs: 250, maxPerSession: 4 });
    const sessionId = newSession("process-tool");
    const otherSession = newSession("process-other");
    const finished = await create(manager, sessionId, quickCommand("tool-done"), {
      notify: "never",
    });
    await waitStatus(manager, sessionId, finished.jobId, "terminal");

    const context = {
      sessionID: sessionId,
      jobs: manager,
      policy: { allowShell: true, allowWrite: true },
    };
    const list = await processTool({ action: "list" }, context);
    assert.equal(list.success, true);
    assert.ok(list.jobs.some((job) => job.jobId === finished.jobId));

    const poll = await processTool(
      { action: "poll", jobId: finished.jobId },
      context,
    );
    assert.equal(poll.success, true);
    assert.equal(poll.status, "completed");
    assert.match(poll.tail, /tool-done/);

    const log = await processTool(
      { action: "log", jobId: finished.jobId, limitBytes: 5 },
      context,
    );
    assert.equal(log.success, true);
    assert.ok(log.bytesRead <= 5);

    const crossSession = await processTool(
      { action: "poll", jobId: finished.jobId, sessionId: otherSession },
      { ...context, sessionID: otherSession },
    );
    assert.equal(crossSession.success, false);
    assert.equal(crossSession.code, "JOB_NOT_FOUND");

    const denied = await processTool(
      { action: "list" },
      { ...context, policy: { allowShell: false, allowWrite: false } },
    );
    assert.equal(denied.success, false);

    const active = await create(manager, sessionId, longCommand(), {
      notify: "never",
    });
    const activeRemove = await processTool(
      { action: "remove", jobId: active.jobId },
      context,
    );
    assert.equal(activeRemove.success, false);
    assert.equal(activeRemove.code, "JOB_ACTIVE");
    await manager.kill(active.jobId, sessionId);

    const removed = await processTool(
      { action: "remove", jobId: finished.jobId },
      context,
    );
    assert.equal(removed.success, true);
    await assert.rejects(fsp.access(finished.logPath));
  });

  it("kills active jobs when the HTTP session-delete path runs", async () => {
    const manager = managerFor({ pollIntervalMs: 250 });
    const sessionId = newSession("delete-session");
    const job = await create(manager, sessionId, longCommand(), {
      notify: "never",
    });
    const running = await waitStatus(manager, sessionId, job.jobId, "running");
    assert.equal(isProcessAlive(running.runnerPid), true);

    const body = await new Promise((resolve, reject) => {
      const req = {
        params: { session_id: sessionId },
        app: { locals: { jobs: manager } },
      };
      const res = {
        status() {
          return res;
        },
        send(value) {
          resolve(value);
        },
      };
      void sessionController.deleteSession(req, res, reject);
    });
    assert.ok(body);
    assert.equal(jobStore.getJob(job.jobId), undefined);
    await waitFor(() => !isProcessAlive(running.runnerPid));
    assert.equal(sessionDoor.getSession(sessionId), undefined);
  });
});

describe("job auto-continue", () => {
  function fakeRuntime(onTurn) {
    const runtime = {
      calls: 0,
      async *runTurn(input) {
        runtime.calls += 1;
        if (onTurn) await onTurn(input);
        yield {
          role: EVENT.TURN_START,
          content: { session_id: input.session_id, replayed: false },
        };
      },
    };
    return runtime;
  }

  function persistNoticeTurn(input) {
    sessionDoor.beginTurn(input.session_id, input.prompt, {
      clientMessageId: input.client_message_id,
      turnKind: input.turnKind,
      triggerRef: input.triggerRef,
      eventRole: EVENT.JOB_NOTICE,
      eventContent: { text: input.prompt, job_id: input.triggerRef },
    });
    sessionDoor.recordEvent(input.session_id, {
      role: EVENT.ASSISTANT,
      content: { text: "continued after job" },
    });
    sessionDoor.commitTurn(input.session_id, 0);
  }

  it("creates exactly one job turn and one delivered notification", async () => {
    const manager = managerFor();
    const sessionId = newSession("notice-once");
    const job = seedJob({ sessionId, notify: "always" });
    const runtime = fakeRuntime(persistNoticeTurn);
    const notice = noticeFor(runtime, manager);

    const first = await notice.enqueue(job.id);
    const second = await notice.enqueue(job.id);
    assert.equal(first.status, "delivered");
    assert.ok(["nothing-to-do", "already-scheduled"].includes(second.status));
    assert.equal(runtime.calls, 1);

    const row = jobStore.getNotification(job.id);
    assert.equal(row.state, "delivered");
    assert.equal(row.attempts, 1);

    const turns = sessionDoor.listTurns(sessionId, { limit: 10 });
    assert.equal(turns.length, 1);
    assert.equal(turns[0].kind, "job");
    assert.equal(turns[0].trigger_ref, job.id);

    const conversation = sessionDoor.getConversation(sessionId);
    assert.equal(conversation[0].role, EVENT.JOB_NOTICE);
    assert.equal(conversation[0].content.job_id, job.id);
    assert.equal(conversation[1].role, EVENT.ASSISTANT);
  });

  it("waits for an idle session without consuming an attempt", async () => {
    const manager = managerFor();
    const sessionId = newSession("notice-busy");
    const job = seedJob({ sessionId, notify: "always" });
    const runtime = fakeRuntime(persistNoticeTurn);
    let busy = true;
    const notice = noticeFor(runtime, manager, {
      session: {
        getSession: sessionDoor.getSession,
        isSessionBusy: () => busy,
      },
    });

    const busyResult = await notice.enqueue(job.id);
    assert.equal(busyResult.status, "busy");
    assert.equal(runtime.calls, 0);
    const pending = jobStore.getNotification(job.id);
    assert.equal(pending.state, "pending");
    assert.equal(pending.attempts, 0);

    busy = false;
    const delivered = await notice.enqueue(job.id);
    assert.equal(delivered.status, "delivered");
    assert.equal(runtime.calls, 1);
    assert.equal(jobStore.getNotification(job.id).attempts, 1);
  });

  it("leaves notifications pending when autoContinue is false", async () => {
    const manager = managerFor({ autoContinue: false });
    const sessionId = newSession("notice-off");
    const job = seedJob({ sessionId, notify: "always" });
    const runtime = fakeRuntime(persistNoticeTurn);
    const notice = noticeFor(runtime, manager);

    const result = await notice.enqueue(job.id);
    assert.equal(result.status, "disabled");
    assert.equal(runtime.calls, 0);
    assert.equal(jobStore.getNotification(job.id).state, "pending");
  });

  it("caps auto-continue at ten job turns per session per hour", async () => {
    const manager = managerFor();
    const sessionId = newSession("notice-rate");
    for (let index = 0; index < 10; index += 1) {
      sessionDoor.beginTurn(sessionId, `job wake ${index}`, {
        clientMessageId: `job:rate-${index}`,
        turnKind: "job",
        triggerRef: `job_rate_${index}`,
      });
      sessionDoor.recordEvent(sessionId, {
        role: EVENT.ASSISTANT,
        content: { text: "ok" },
      });
      sessionDoor.commitTurn(sessionId, 0);
    }

    const job = seedJob({ sessionId, notify: "always" });
    const runtime = fakeRuntime(persistNoticeTurn);
    const notice = noticeFor(runtime, manager);

    const result = await notice.enqueue(job.id);
    assert.equal(result.status, "rate-limited");
    assert.equal(runtime.calls, 0);
    assert.equal(jobStore.getNotification(job.id).state, "pending");
  });

  it("never auto-starts a job finished more than 24 hours ago", async () => {
    const manager = managerFor();
    const sessionId = newSession("notice-expired");
    const job = seedJob({
      sessionId,
      notify: "always",
      finishedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const runtime = fakeRuntime(persistNoticeTurn);
    const notice = noticeFor(runtime, manager);

    const result = await notice.enqueue(job.id);
    assert.equal(result.status, "expired");
    assert.equal(runtime.calls, 0);
    const row = jobStore.getNotification(job.id);
    assert.equal(row.state, "failed");
    assert.match(row.last_error, /24 hours/);
  });

  it("drops a notice whose session was deleted", async () => {
    const manager = managerFor();
    const sessionId = newSession("notice-deleted");
    const job = seedJob({ sessionId, notify: "always" });
    sessionDoor.deleteSession(sessionId);
    SESSION_IDS.delete(sessionId);

    const runtime = fakeRuntime(persistNoticeTurn);
    const notice = noticeFor(runtime, manager);
    const result = await notice.enqueue(job.id);
    assert.equal(result.status, "missing");
    assert.equal(runtime.calls, 0);
  });
});

describe("job notice runtime contract", () => {
  it("persists JOB_NOTICE but keeps it out of provider input", async () => {
    const provider = createFakeProvider({
      turns: [textTurn("continued by the agent")],
    });
    const sessionId = newSession("runtime-notice");
    const noticeText = [
      "<background-job id=\"job_runtime_notice\" status=\"completed\" exitCode=\"0\" timedOut=\"false\">",
      "Command: echo RUNTIME-NOTICE-MARKER",
      "Tail:",
      "RUNTIME-NOTICE-TAIL",
      "</background-job>",
    ].join("\n");

    const deps = {
      session: sessionDoor,
      getConfig: () => ({
        model: "fake/fake-model",
        username: "tester",
        compaction: { ratio: 85, keep_turn: 2 },
      }),
      getCatalog: () => null,
      resolveModel: async () => ({
        adapter: provider,
        model: FAKE_MODEL,
        limits: {
          contextWindow: FAKE_MODEL.contextWindow,
          maxOutputTokens: FAKE_MODEL.maxOutputTokens,
        },
        capabilities: FAKE_MODEL.capabilities,
      }),
      logger: { info() {}, warn() {}, error() {} },
    };

    const events = [];
    for await (const event of runTurn({
      name: "nano",
      prompt: noticeText,
      session_id: sessionId,
      client_message_id: "job:job_runtime_notice",
      turnKind: "job",
      triggerRef: "job_runtime_notice",
      jobNotice: noticeText,
      deps,
    })) {
      events.push(event);
    }
    assert.ok(events.some((event) => event.role === EVENT.ASSISTANT));

    const request = provider.calls.request[0];
    assert.match(request.instruction, /RUNTIME-NOTICE-MARKER/);
    assert.ok(
      !JSON.stringify(request.input).includes("RUNTIME-NOTICE-MARKER"),
      "JOB_NOTICE must not reach provider input",
    );

    const turns = sessionDoor.listTurns(sessionId, { limit: 5 });
    assert.equal(turns[0].kind, "job");
    assert.equal(turns[0].trigger_ref, "job_runtime_notice");
    const conversation = sessionDoor.getConversation(sessionId);
    assert.equal(conversation[0].role, EVENT.JOB_NOTICE);
    assert.equal(conversation[0].content.job_id, "job_runtime_notice");
  });
});

describe("job runner boundary", () => {
  it("imports only Node builtins and kill-tree", () => {
    const source = fs.readFileSync(
      new URL("../../src/jobs/runner.js", import.meta.url),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(imports.sort(), [
      "./kill-tree.js",
      "node:child_process",
      "node:fs",
      "node:fs/promises",
      "node:path",
    ]);
    assert.ok(!source.includes("#src/"));
    assert.ok(!/from\s+["'][^"']*(?:session|settings|provider|agent)/i.test(source));
  });
});
