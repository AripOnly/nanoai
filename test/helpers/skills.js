// test/helpers/skills.js
//
// Shared fixtures for the skills suites. Everything writes into a fresh temp
// directory; tests inject those paths into the registry/installer instead of
// touching the process-wide NANO_DATA_DIR.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSkillTree } from "../../src/skills/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_PDF = path.join(
  HERE,
  "..",
  "fixtures",
  "skills",
  "fixture-pdf",
);
export const FIXTURE_EXTERNAL = path.join(
  HERE,
  "..",
  "fixtures",
  "skills",
  "external-report",
);
export const KNOWN_TOOLS = [
  "read",
  "write",
  "edit",
  "shell",
  "glob",
  "grep",
  "webFetch",
  "webSearch",
  "writeWord",
  "writeExcel",
  "process",
];

export async function makeTempRoot(prefix = "nano-skills-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function yamlList(values) {
  return `[${(values ?? []).map((item) => JSON.stringify(item)).join(", ")}]`;
}

export async function writeSkill(
  root,
  name,
  {
    description = `Test skill ${name}.`,
    body = `# ${name}\n\nFollow the test instructions.`,
    tags = [],
    triggers = [],
    autoLoad = false,
    os = [],
    requires = {},
    allowedTools = ["read"],
    trust = null,
    source = `test/${name}`,
    version = "1.0.0",
    manifestHash = null,
    extraFiles = {},
  } = {},
) {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });

  const lines = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    `allowed-tools: ${yamlList(allowedTools)}`,
    "metadata:",
    `  version: ${JSON.stringify(version)}`,
  ];
  if (os.length > 0) lines.push(`  os: ${yamlList(os)}`);
  if (tags.length > 0) lines.push(`  tags: ${yamlList(tags)}`);
  if (triggers.length > 0) lines.push(`  triggers: ${yamlList(triggers)}`);
  lines.push(`  autoLoad: ${autoLoad}`);
  if (Object.keys(requires).length > 0) {
    lines.push("  requires:");
    for (const [key, values] of Object.entries(requires)) {
      lines.push(`    ${key}: ${yamlList(values)}`);
    }
  }
  lines.push("---", "", body);
  await fs.writeFile(path.join(directory, "SKILL.md"), lines.join("\n"));

  for (const [relative, content] of Object.entries(extraFiles)) {
    const target = path.join(directory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  if (trust !== null) {
    const validated = await validateSkillTree(directory, {
      knownTools: KNOWN_TOOLS,
    });
    await fs.writeFile(
      path.join(directory, ".nanoai-skill.json"),
      `${JSON.stringify(
        {
          source,
          requested: source,
          resolvedRef: null,
          contentHash: manifestHash ?? validated.contentHash,
          version,
          installedAt: "2026-10-21T00:00:00.000Z",
          skillsCliVersion: "1.7.4",
          trust,
          scanner: "none",
          telemetryDisabled: true,
        },
        null,
        2,
      )}\n`,
    );
  }

  return directory;
}

/** Fake skills.sh runner: copies a local fixture into the staging cwd. */
export function copyFixtureRunner(fixture = FIXTURE_PDF, folder = "fixture-pdf") {
  const calls = [];
  const runner = async ({ args, cwd, env, timeoutMs }) => {
    calls.push({ args, cwd, env, timeoutMs });
    const target = path.join(cwd, "skills", folder);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(fixture, target, { recursive: true });
    return { code: 0, stdout: "installed", stderr: "" };
  };
  runner.calls = calls;
  return runner;
}

export async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
