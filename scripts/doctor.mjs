// scripts/doctor.mjs
//
// Preflight health check for a 24/7 nano installation. Read-only except for
// a throwaway write probe inside the workspace (proves writability) and a
// first-time ripgrep download (proves the search path works end to end).
// Exit 0 when every check passes, 1 otherwise. English output, one line
// per check: "[ok]" or "[FAIL] <what to do>".

import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "#src/shared/data-dir.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const failures = [];

function ok(label, detail = "") {
  console.log(`[ok] ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, remedy) {
  failures.push(label);
  console.log(`[FAIL] ${label} — ${remedy}`);
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isInteger(major) && major >= 22) {
    ok(`Node.js ${process.version} (>= 22 required)`);
    return;
  }
  fail(`Node.js ${process.version}`, "Install Node.js 22 or newer (24 recommended).");
}

function checkDependencies() {
  const modules = path.join(ROOT, "node_modules");
  if (!fs.statSync(modules, { throwIfNoEntry: false })?.isDirectory()) {
    fail("node_modules missing", "Run: npm install");
    return;
  }
  ok("Dependencies installed (node_modules present)");
}

async function checkWorkspace() {
  const { resolveWorkspaceRoot } = await import("#src/tools/shared/workspace.js");
  let root;
  try {
    root = resolveWorkspaceRoot();
  } catch (error) {
    fail("Workspace root", error instanceof Error ? error.message : String(error));
    return;
  }
  const probe = path.join(root, `.doctor-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "ok", "utf8");
    fs.rmSync(probe, { force: true });
    ok(`Workspace writable: ${root}`);
  } catch {
    fail(`Workspace not writable: ${root}`, "Fix permissions or set NANO_WORKSPACE to a writable folder.");
  }
}

async function checkSettings() {
  try {
    const { settings } = await import("#src/config/config.js");
    const model = await settings.get("model");
    if (typeof model !== "string" || !model.includes("/")) {
      fail("Settings model value", 'Set "model" to "<provider>/<model>" via the CLI setup.');
      return;
    }
    ok(`Settings readable (model: ${model})`);
  } catch (error) {
    fail("Settings unreadable", error instanceof Error ? error.message : String(error));
  }
}

async function checkDatabase() {
  // Open read-only with a locally computed path: doctor must not import the
  // shared sql module (importing it would create/migrate/lock the live DB).
  const dbPath = path.join(dataDir(), "memories.db");
  if (!fs.statSync(dbPath, { throwIfNoEntry: false })?.isFile()) {
    ok("Database not initialized yet (created on first gateway boot)");
    return;
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (!integrity || integrity.integrity_check !== "ok") {
      fail("Database integrity check", `Got: ${integrity?.integrity_check}. Restore from a backup (see the backups folder in the data dir).`);
      return;
    }
    const { SCHEMA_VERSION } = await import("#src/session/migrations.js");
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      fail(`Database schema v${version} newer than code v${SCHEMA_VERSION}`, "Update nano before starting.");
      return;
    }
    ok(`Database integrity ok (schema v${version}, code v${SCHEMA_VERSION})`);
  } catch (error) {
    fail("Database unreadable", error instanceof Error ? error.message : String(error));
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors on a broken handle.
    }
  }
}

async function checkSearch() {
  try {
    const { resolveRgBinary } = await import("#src/tools/shared/rg.js");
    const binary = await resolveRgBinary();
    ok(`Search backend ready: ${binary}`);
  } catch (error) {
    fail("Search backend (ripgrep)", error instanceof Error ? error.message : String(error));
  }
}

function checkDisk() {
  try {
    const stats = fs.statfsSync(dataDir());
    const freeGB = (Number(stats.bfree) * Number(stats.bsize)) / 1024 ** 3;
    if (freeGB < 1) {
      fail(`Disk space low (${freeGB.toFixed(2)} GB free)`, "Free at least 1 GB for database and attachments.");
      return;
    }
    ok(`Disk space: ${freeGB.toFixed(1)} GB free`);
  } catch {
    ok("Disk check skipped (filesystem stats unavailable)");
  }
}

async function checkGateway() {
  // Prefer the live readiness probe over a blind port check: it distinguishes
  // "gateway up" from "gateway up and healthy".
  const port = Number(process.env.PORT ?? 3060);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!response.ok) {
      console.log(`[info] Gateway answers on ${port} but reports degraded (HTTP ${response.status}).`);
      return;
    }
    const health = await response.json();
    console.log(
      `[info] Gateway healthy on ${port} (v${health.version ?? "?"}, uptime ${health.uptime ?? "?"}s). Stop it before booting another instance.`,
    );
  } catch {
    console.log(`[info] Gateway not running on ${port} (safe to boot).`);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`doctor: Node ${process.version} on ${os.platform()} (${os.arch})`);
  checkNode();
  checkDependencies();
  await checkWorkspace();
  await checkSettings();
  await checkDatabase();
  await checkSearch();
  checkDisk();
  await checkGateway();
  if (failures.length > 0) {
    console.log(`\ndoctor: ${failures.length} failing check(s). Fix the [FAIL] lines above, then re-run.`);
    process.exitCode = 1;
    return;
  }
  console.log("\ndoctor: all checks passed.");
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) {
  main().catch((error) => {
    console.error(`doctor crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
