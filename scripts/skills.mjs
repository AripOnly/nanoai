#!/usr/bin/env node
// scripts/skills.mjs
//
// Explicit skill management. This is the only place that imports the installer:
// the gateway can list/reload skills, but the model loop can never install,
// update, or remove one. Every install requires a visible user confirmation and
// records a SHA-256 tree hash plus provenance in skills.lock.json.

import { createInterface } from "node:readline/promises";
import { getSnapshot, initSettings } from "#src/config/index.js";
import { dataDir } from "#src/shared/data-dir.js";
import {
  createSkillRegistry,
  installSkill,
  removeSkill,
  updateSkill,
} from "#src/skills/index.js";
import { toolRegistry } from "#src/tools/registry.js";

function safeTerminal(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function fail(message) {
  throw new Error(safeTerminal(message));
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = String(argv[index]);
    if (item === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const [rawKey, inline] = item.slice(2).split("=", 2);
    const key = rawKey.toLowerCase();
    if (["json", "yes", "help"].includes(key)) {
      options[key] = true;
      continue;
    }
    if (["skill", "trust"].includes(key)) {
      const value = inline ?? argv[index + 1];
      if (typeof value !== "string" || value === "" || value.startsWith("--")) {
        fail(`--${key} requires a value.`);
      }
      options[key] = value;
      if (inline === undefined) index += 1;
      continue;
    }
    fail(`Unknown option --${rawKey}.`);
  }
  return { positional, options };
}

function helpText() {
  return [
    "nanoai skills — explicit skill management",
    "",
    "Usage:",
    "  nanoai skills add <owner/repo[/skill]> [--skill <name>] [--trust user-approved] [--yes]",
    "  nanoai skills add <url> --skill <name> [--trust user-approved] [--yes]",
    "  nanoai skills add <path> [--skill <name>] [--trust user-approved] [--yes]",
    "  nanoai skills list [--json]",
    "  nanoai skills inspect <name> [--json]",
    "  nanoai skills remove <name> [--yes]",
    "  nanoai skills update <name> [--yes]",
    "  nanoai skills reload [--json]",
    "",
    "Installs ask for confirmation. With --yes, --trust user-approved is required.",
    "",
    "Skills are prompt content, not code. NanoAI never executes skill scripts.",
    "External skills are untrusted until you explicitly install them; their",
    "bodies are never auto-loaded. skills.sh scanners are not a security",
    "guarantee.",
    "",
    "The gateway is never required to add/remove/update; it reloads through its",
    "watcher, and `nanoai skills reload` also calls the running gateway API.",
  ].join("\n");
}

async function confirm(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("Interactive confirmation is unavailable; pass --yes --trust user-approved.");
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function settingsValue() {
  return getSnapshot()?.value ?? {};
}

function registry() {
  const knownTools = toolRegistry
    .names()
    .filter((name) => name !== "loadSkill" && name !== "searchSkills");
  return createSkillRegistry({
    config: getSnapshot,
    knownTools,
  });
}

function gatewayBase() {
  const value = settingsValue();
  const port = Number.isInteger(value.gateway?.port)
    ? value.gateway.port
    : Number(process.env.PORT ?? 3060);
  return `http://127.0.0.1:${port}`;
}

async function reloadGateway() {
  const value = settingsValue();
  const token =
    (typeof process.env.NANO_GATEWAY_TOKEN === "string" &&
    process.env.NANO_GATEWAY_TOKEN.trim() !== ""
      ? process.env.NANO_GATEWAY_TOKEN.trim()
      : null) ??
    (typeof value.gateway_token === "string" && value.gateway_token !== ""
      ? value.gateway_token
      : null);
  if (!token) return { reached: false, reason: "no gateway token" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  timer.unref?.();
  try {
    const response = await fetch(`${gatewayBase()}/api/v1/skills/reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { reached: true, ok: false, status: response.status };
    }
    const body = await response.json().catch(() => ({}));
    return { reached: true, ok: true, body };
  } catch (error) {
    return {
      reached: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function printTable(skills) {
  if (skills.length === 0) {
    console.log("No skills installed.");
    return;
  }
  const rows = skills.map((skill) => [
    skill.name,
    skill.trust,
    skill.version ?? "-",
    skill.hash ?? "-",
    skill.status,
  ]);
  const headers = ["NAME", "TRUST", "VERSION", "HASH", "STATUS"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index]).length)),
  );
  const line = (row) =>
    row
      .map((cell, index) => String(cell).padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  console.log(line(headers));
  for (const row of rows) console.log(line(row));
}

async function commandAdd(argv) {
  const { positional, options } = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  if (positional.length !== 1) {
    fail(
      "Usage: nanoai skills add <source> [--skill <name>] [--trust user-approved] [--yes]",
    );
  }
  if (options.trust !== undefined && options.trust !== "user-approved") {
    fail("--trust must be user-approved.");
  }
  if (options.yes && options.trust !== "user-approved") {
    fail(
      "Non-interactive install requires --trust user-approved (only use it after reviewing the source).",
    );
  }

  const sourceLabel = safeTerminal(positional[0]);
  console.log(`Source: ${sourceLabel}`);
  if (typeof options.skill === "string") {
    console.log(`Skill: ${safeTerminal(options.skill)}`);
  }
  console.log(
    "Warning: skills are untrusted prompt content and are not scanned by NanoAI for safety. " +
      "skills.sh scanners are not a security guarantee.",
  );
  if (!options.yes) {
    const accepted = await confirm(
      `Install "${sourceLabel}" and trust it as user-approved prompt content?`,
    );
    if (!accepted) {
      console.log("Cancelled.");
      return 0;
    }
  }
  const result = await installSkill({
    source: positional[0],
    skill: options.skill ?? null,
    trust: "user-approved",
    knownTools: toolRegistry
      .names()
      .filter((name) => name !== "loadSkill" && name !== "searchSkills"),
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `${result.replaced ? "Updated" : "Installed"} ${result.name} (${result.trust}, ${result.hash}).`,
    );
    console.log(`Source: ${safeTerminal(result.source)}`);
  }
  await reloadGateway();
  return 0;
}

async function commandList(argv) {
  const { options } = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  const skills = registry();
  await skills.init();
  const list = skills.list();
  if (options.json) {
    console.log(
      JSON.stringify({ revision: skills.revision, skills: list }, null, 2),
    );
  } else {
    printTable(list);
    if (skills.health().lastError) {
      console.error(`Warning: ${safeTerminal(skills.health().lastError)}`);
    }
  }
  return 0;
}

async function commandInspect(argv) {
  const { positional, options } = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  if (positional.length !== 1) fail("Usage: nanoai skills inspect <name>");
  const skills = registry();
  await skills.init();
  const entry = skills.inspect(positional[0]);
  if (!entry) fail(`Skill "${positional[0]}" is not installed.`);

  if (options.json) {
    console.log(JSON.stringify(entry, null, 2));
    return 0;
  }
  console.log(`Name: ${entry.name}`);
  console.log(`Description: ${safeTerminal(entry.description)}`);
  console.log(`Trust: ${entry.trust}`);
  console.log(`Status: ${entry.status}`);
  console.log(`Version: ${entry.version ?? "-"}`);
  console.log(`Hash: ${entry.hash}`);
  console.log(`Source: ${safeTerminal(entry.source ?? "-")}`);
  console.log(`Requested: ${safeTerminal(entry.requested ?? "-")}`);
  console.log(`Allowed tools: ${entry.allowedTools.join(", ") || "(agent tools)"}`);
  if (entry.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of entry.warnings) {
      console.log(`- ${safeTerminal(warning)}`);
    }
  }
  const files = entry.files.map((file) => file.path);
  if (files.length > 0) console.log(`Supporting files: ${files.join(", ")}`);
  console.log("");
  console.log(safeTerminal(entry.body));
  return 0;
}

async function commandRemove(argv) {
  const { positional, options } = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  if (positional.length !== 1) fail("Usage: nanoai skills remove <name> [--yes]");
  if (!options.yes) {
    const accepted = await confirm(`Remove skill "${safeTerminal(positional[0])}"?`);
    if (!accepted) {
      console.log("Cancelled.");
      return 0;
    }
  }
  const result = await removeSkill({ name: positional[0] });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`Removed ${result.name}.`);
  await reloadGateway();
  return 0;
}

async function commandUpdate(argv) {
  const { positional, options } = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  if (positional.length !== 1) fail("Usage: nanoai skills update <name> [--yes]");
  if (!options.yes) {
    const accepted = await confirm(
      `Reinstall "${safeTerminal(positional[0])}" from its recorded source?`,
    );
    if (!accepted) {
      console.log("Cancelled.");
      return 0;
    }
  }
  const result = await updateSkill({
    name: positional[0],
    knownTools: toolRegistry
      .names()
      .filter((name) => name !== "loadSkill" && name !== "searchSkills"),
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `${result.changed ? "Updated" : "Unchanged"} ${result.name}: ${
        result.previousHash ?? "?"
      } -> ${result.hash}`,
    );
  }
  await reloadGateway();
  return 0;
}

async function commandReload(argv) {
  const { options } = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  const skills = registry();
  const snapshot = await skills.reload({ reason: "cli" });
  const gateway = await reloadGateway();
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          revision: snapshot.revision,
          skills: skills.list(),
          gateway: gateway.reached ? gateway.body ?? { ok: gateway.ok } : null,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Skill registry reloaded (revision ${snapshot.revision}, ${snapshot.entries.length} skill(s)).`,
    );
    if (snapshot.lastError) console.error(`Warning: ${safeTerminal(snapshot.lastError)}`);
    if (!gateway.reached) {
      console.log(`Gateway not reloaded: ${safeTerminal(gateway.reason ?? "unreachable")}.`);
    }
  }
  return 0;
}

async function main() {
  const [rawCommand, ...argv] = process.argv.slice(2);
  const command = String(rawCommand ?? "").toLowerCase();
  if (command === "" || command === "help" || command === "--help" || command === "-h") {
    console.log(helpText());
    return 0;
  }

  try {
    await initSettings();
  } catch (error) {
    fail(
      `Settings could not be loaded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  switch (command) {
    case "add":
      return commandAdd(argv);
    case "list":
    case "ls":
      return commandList(argv);
    case "inspect":
    case "show":
      return commandInspect(argv);
    case "remove":
    case "rm":
      return commandRemove(argv);
    case "update":
    case "upgrade":
      return commandUpdate(argv);
    case "reload":
      return commandReload(argv);
    default:
      fail(`Unknown skills command "${command}".\n\n${helpText()}`);
  }
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    console.error(`nanoai skills: ${safeTerminal(error?.message ?? error)}`);
    process.exitCode = 1;
  });
