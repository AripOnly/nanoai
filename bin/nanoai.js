#!/usr/bin/env node
// bin/nanoai.js — the `nanoai` command. One-shot subcommands that work from any
// folder; all paths resolve absolutely from this file's location. Only `cli`
// needs an interactive terminal (it hosts the Ink chat UI).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSupervisor, dashboardUrl, helpText, parseArgs } from "../apps/console/lib/supervisor.js";

export { createSupervisor, dashboardUrl, helpText, parseArgs };

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 3060);

function fail(message) {
  console.log(message);
  process.exit(1);
}

function tsxTarget() {
  return path.join(repoRoot, "apps", "cli", "main.jsx");
}

function runChat() {
  // Reuse the existing chat entry through tsx (JSX needs no build step).
  const tsxBin =
    process.platform === "win32"
      ? path.join(repoRoot, "node_modules", ".bin", "tsx.cmd")
      : path.join(repoRoot, "node_modules", ".bin", "tsx");
  const appEntry = path.join(repoRoot, "app.jsx");
  const entry = fs.existsSync(appEntry) ? appEntry : tsxTarget();
  const argv = [entry];
  const options = { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" };
  const result = fs.existsSync(tsxBin)
    ? spawnSync(tsxBin, argv, options)
    : spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", ...argv], options);
  if (result.error) fail(`nanoai: failed to start chat (${result.error.message})`);
  process.exit(result.status ?? 1);
}

async function gatewayHealthy() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  const { name, args, raw } = parseArgs(process.argv.slice(2));
  const supervisor = createSupervisor({ repoRoot, port: PORT });

  if (name === "help") {
    console.log(helpText());
    return;
  }
  if (name === "version") {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
      console.log(`nanoai v${pkg.version ?? "?"}`);
    } catch {
      console.log("nanoai v?");
    }
    return;
  }
  if (name === "web") {
    console.log(dashboardUrl(PORT));
    return;
  }
  if (name === "cli") {
    if (!(await gatewayHealthy())) {
      fail(`Gateway is not running (port ${PORT}). Start it first: nanoai gateway start`);
    }
    runChat();
    return;
  }
  if (name.startsWith("gateway:")) {
    const action = name.slice("gateway:".length);
    if (action === "start") {
      const result = await supervisor.start();
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
    }
    if (action === "stop") {
      const result = await supervisor.stop();
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
    }
    if (action === "restart") {
      const result = await supervisor.restart();
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
    }
    if (action === "status") {
      const result = await supervisor.status();
      console.log(result.message);
      process.exit(0);
    }
    if (action === "log") {
      const count = Number.parseInt(args[0] ?? "20", 10);
      console.log(supervisor.logTail(count));
      process.exit(0);
    }
  }
  console.log(`Unknown command: ${raw ?? ""}.\n\n${helpText()}`);
  process.exit(1);
}

// Importable without side effects (tests); only auto-run as the CLI entry.
// Note: argv[1] may traverse the npm-linked symlink while import.meta.url is
// already realpath-resolved, so compare canonical paths (or fall back to
// basename comparison) instead of raw strings.
function isInvokedAsCli() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return path.basename(process.argv[1] ?? "").toLowerCase() === "nanoai.js";
  }
}
if (isInvokedAsCli()) {
  main().catch((error) => {
    console.error(`nanoai: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
