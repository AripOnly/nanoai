// src/skills/installer.js
//
// Explicit, out-of-band skill installation. The model loop never imports this
// module. `add` runs the skills.sh CLI inside a private staging directory,
// validates the downloaded tree, records a SHA-256 tree hash, and only then
// swaps it into the user skills directory and updates the lockfile atomically.
//
// No script, hook, or executable from a skill is ever run.

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT, dataDir } from "#src/shared/data-dir.js";
import {
  SkillError,
  SKILL_NAME_RE,
  SKILL_MANIFEST_FILENAME as MANIFEST_FILE,
  parseSkillManifest,
} from "./loader.js";
import {
  readLockfile,
  shortHash,
  withLockEntry,
  withoutLockEntry,
  writeLockfile,
} from "./lockfile.js";
import {
  copySkillTree,
  DEFAULT_MAX_SKILL_BYTES,
  findSkillRoots,
  validateSkillTree,
} from "./validate.js";

export const SKILLS_CLI_VERSION = "1.7.4";
export const SKILLS_CLI_PACKAGE = "skills";

const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SAFE_ERROR_CHARS = 800;

function fail(message, code = "SKILL_INSTALL_FAILED") {
  throw new SkillError(message, code);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function validateSkillName(name) {
  if (typeof name !== "string" || !SKILL_NAME_RE.test(name)) {
    fail(
      "Skill name is unsafe. Use lowercase letters, digits, dot, underscore, or dash (max 64 chars).",
      "SKILL_NAME_INVALID",
    );
  }
  return name;
}

/**
 * Parse `<owner/repo[/skill]>`, a URL, or an explicit local path used by the
 * installer tests. Path traversal is not a concern here because the source is
 * only handed to the CLI as an argument, never joined into a write target.
 */
export function parseSkillSource(input, { skill = null, cwd = process.cwd() } = {}) {
  if (typeof input !== "string" || input.trim() === "") {
    fail("A skill source is required.", "SKILL_SOURCE_INVALID");
  }
  const source = input.trim();
  if (source.length > 1024 || /[\0\r\n]/.test(source)) {
    fail("Skill source contains invalid characters.", "SKILL_SOURCE_INVALID");
  }
  if (skill !== null) validateSkillName(skill);

  if (/^https?:\/\//i.test(source)) {
    let url;
    try {
      url = new URL(source);
    } catch {
      fail("Skill source URL is invalid.", "SKILL_SOURCE_INVALID");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      fail("Skill source URL must use http or https.", "SKILL_SOURCE_INVALID");
    }
    if (url.username !== "" || url.password !== "") {
      fail("Skill source URL must not contain credentials.", "SKILL_SOURCE_INVALID");
    }
    return {
      kind: "url",
      source,
      requested: skill ? `${source}#${skill}` : source,
      skill,
    };
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(source)) {
    const parts = source.split("/");
    const inferred = parts[2] ?? null;
    if (inferred !== null && skill !== null && inferred !== skill) {
      fail(
        `Source names skill "${inferred}" but --skill specifies "${skill}".`,
        "SKILL_SOURCE_INVALID",
      );
    }
    return {
      kind: "repository",
      source: parts.slice(0, 2).join("/"),
      requested: source,
      skill: skill ?? inferred,
    };
  }

  if (
    source.startsWith("./") ||
    source.startsWith(".\\") ||
    source.startsWith("../") ||
    source.startsWith("..\\") ||
    path.isAbsolute(source)
  ) {
    // The skills CLI runs inside a private staging directory, so a relative
    // local source must be resolved against the caller's cwd before staging.
    // Keep the original spelling as `requested` for display/provenance, but
    // store the absolute path as the reproducible source.
    return {
      kind: "local",
      source: path.resolve(cwd, source),
      requested: source,
      skill,
    };
  }

  fail(
    "Skill source must be owner/repo[/skill], an http(s) URL, or a local path.",
    "SKILL_SOURCE_INVALID",
  );
}

/** Build the restricted environment handed to npx/skills.sh. */
export function buildInstallerEnv(env = process.env) {
  const allowed = new Set([
    "PATH",
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TERM",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NPM_CONFIG_REGISTRY",
    "npm_config_registry",
  ]);
  const result = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (allowed.has(key) && typeof value === "string") {
      result[key] = value;
    }
  }
  result.DISABLE_TELEMETRY = "1";
  result.NO_COLOR = "1";
  result.CI = "1";
  result.npm_config_update_notifier = "false";
  result.npm_config_fund = "false";
  result.npm_config_audit = "false";
  return result;
}

function appendBounded(current, chunk) {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  return (current + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
}

function terminate(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", () => {});
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    try {
      child.kill();
    } catch {
      // The process may already be gone.
    }
  }
}

/**
 * Default npx runner. Returns {code, stdout, stderr}; never throws for a
 * non-zero exit (the caller adds context and a safe error message).
 */
export function defaultRunSkillsCli({
  args,
  cwd,
  env = buildInstallerEnv(),
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const npxCli = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npx-cli.js",
    );
    const useLocalCli = fsSync.existsSync(npxCli);
    const command = useLocalCli
      ? process.execPath
      : process.platform === "win32"
        ? "npx.cmd"
        : "npx";
    const argv = useLocalCli ? [npxCli, ...args] : args;

    let child;
    try {
      child = spawn(command, argv, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(
        new SkillError(
          `Could not start skills.sh: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "SKILL_INSTALL_START_FAILED",
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new SkillError(
          `Could not run skills.sh: ${error.message}`,
          "SKILL_INSTALL_START_FAILED",
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new SkillError(
            `skills.sh timed out after ${timeoutMs}ms.`,
            "SKILL_INSTALL_TIMEOUT",
          ),
        );
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function cleanCliOutput(value) {
  const text = String(value ?? "").replace(/\0/g, "").trim();
  return text.length > SAFE_ERROR_CHARS ? text.slice(-SAFE_ERROR_CHARS) : text;
}

async function readDocumentName(root, knownTools) {
  const { readSkillDocument } = await import("./loader.js");
  return readSkillDocument(path.join(root, "SKILL.md"), {
    maxBytes: DEFAULT_MAX_SKILL_BYTES,
    knownTools,
  });
}

async function builtinNames(builtinRoot, knownTools) {
  const names = new Set();
  let roots = [];
  try {
    roots = await findSkillRoots(builtinRoot);
  } catch {
    return names;
  }
  for (const root of roots) {
    try {
      const document = await readDocumentName(root, knownTools);
      names.add(document.name);
    } catch {
      // An invalid builtin must not block installing a user skill with a
      // different name; the registry will report it on its own.
    }
  }
  return names;
}

async function oldContentHash(target, knownTools) {
  if (!fsSync.existsSync(target)) return null;
  try {
    const validated = await validateSkillTree(target, {
      maxSkillBytes: DEFAULT_MAX_SKILL_BYTES,
      knownTools,
    });
    return validated.contentHash;
  } catch {
    try {
      const manifest = parseSkillManifest(
        await fs.readFile(path.join(target, MANIFEST_FILE), "utf8"),
      );
      return manifest.contentHash;
    } catch {
      return null;
    }
  }
}

async function writeManifest(target, manifest) {
  await fs.writeFile(
    path.join(target, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function removePath(target) {
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort; a hidden temp directory is harmless.
  }
}

/**
 * Install one skill from skills.sh.
 *
 * The caller must have obtained explicit user confirmation. Non-interactive
 * callers pass trust: "user-approved"; the CLI requires --trust for that.
 */
export async function installSkill({
  source,
  skill = null,
  trust = "user-approved",
  userRoot = path.join(dataDir(), "skills"),
  builtinRoot = path.join(PACKAGE_ROOT, "src", "skills", "builtin"),
  lockfilePath = path.join(dataDir(), "skills.lock.json"),
  stagingRoot = path.join(dataDir(), "skills-staging"),
  knownTools = null,
  runSkillsCli = defaultRunSkillsCli,
  env = buildInstallerEnv(),
  cliVersion = SKILLS_CLI_VERSION,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
} = {}) {
  if (trust !== "user-approved") {
    fail("Installed skills must be explicitly user-approved.", "SKILL_TRUST_REQUIRED");
  }
  const parsed = parseSkillSource(source, { skill });
  const lock = await readLockfile(lockfilePath);
  const duplicateBuiltin = await builtinNames(builtinRoot, knownTools);
  if (parsed.skill && duplicateBuiltin.has(parsed.skill)) {
    fail(
      `Skill "${parsed.skill}" is already provided by NanoAI builtins.`,
      "SKILL_DUPLICATE_BUILTIN",
    );
  }

  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.mkdir(userRoot, { recursive: true });
  const staging = path.join(stagingRoot, randomUUID());
  let tempTarget = null;
  let backup = null;
  let target = null;

  try {
    await fs.mkdir(staging, { recursive: true });

    const args = [
      "--yes",
      `${SKILLS_CLI_PACKAGE}@${cliVersion}`,
      "add",
      parsed.source,
      ...(parsed.skill ? ["--skill", parsed.skill] : []),
      "--agent",
      "universal",
      "--copy",
      "--yes",
    ];

    const result = await runSkillsCli({
      args,
      cwd: staging,
      env,
      timeoutMs,
    });
    if (!result || result.code !== 0) {
      const detail = cleanCliOutput(result?.stderr || result?.stdout || "");
      fail(
        `skills.sh failed (exit ${result?.code ?? "unknown"})${detail ? `: ${detail}` : "."}`,
        "SKILL_INSTALL_FAILED",
      );
    }

    const roots = await findSkillRoots(staging);
    if (roots.length === 0) {
      fail("skills.sh did not produce a SKILL.md.", "SKILL_INSTALL_EMPTY");
    }

    let chosen = null;
    if (parsed.skill) {
      const matches = [];
      for (const root of roots) {
        try {
          const document = await readDocumentName(root, knownTools);
          if (document.name === parsed.skill) matches.push(root);
        } catch {
          // Invalid candidates are ignored here; the selected one is validated
          // below with a full error.
        }
      }
      if (matches.length !== 1) {
        fail(
          matches.length === 0
            ? `skills.sh did not install the requested skill "${parsed.skill}".`
            : `skills.sh produced multiple copies of "${parsed.skill}".`,
          "SKILL_INSTALL_AMBIGUOUS",
        );
      }
      chosen = matches[0];
    } else if (roots.length === 1) {
      chosen = roots[0];
    } else {
      fail(
        "skills.sh produced multiple skills. Re-run with --skill <name>.",
        "SKILL_INSTALL_AMBIGUOUS",
      );
    }

    const validated = await validateSkillTree(chosen, {
      maxSkillBytes: DEFAULT_MAX_SKILL_BYTES,
      knownTools,
    });
    const name = validateSkillName(validated.document.name);
    if (duplicateBuiltin.has(name)) {
      fail(
        `Skill "${name}" is already provided by NanoAI builtins.`,
        "SKILL_DUPLICATE_BUILTIN",
      );
    }

    target = path.join(userRoot, name);
    if (!isInside(userRoot, target)) {
      fail("Installed skill path escapes the user skills directory.", "SKILL_PATH_ESCAPE");
    }

    const existingLock = lock.skills[name] ?? null;
    const previousHash = await oldContentHash(target, knownTools);
    const installedAt = new Date().toISOString();
    const manifest = Object.freeze({
      source: parsed.source,
      requested: parsed.requested,
      resolvedRef: null,
      contentHash: validated.contentHash,
      version: validated.document.version ?? shortHash(validated.contentHash),
      installedAt,
      skillsCliVersion: cliVersion,
      trust: "user-approved",
      scanner: "none",
      telemetryDisabled: true,
    });

    tempTarget = path.join(userRoot, `.install-${name}-${randomUUID()}`);
    await copySkillTree(chosen, tempTarget);
    await writeManifest(tempTarget, manifest);

    // Hash the copied tree too; a botched copy must never be published.
    const copied = await validateSkillTree(tempTarget, {
      maxSkillBytes: DEFAULT_MAX_SKILL_BYTES,
      knownTools,
    });
    if (copied.contentHash !== validated.contentHash) {
      fail("Copied skill content does not match the validated source.", "SKILL_HASH_MISMATCH");
    }

    let replaced = false;
    if (fsSync.existsSync(target)) {
      backup = path.join(userRoot, `.backup-${name}-${randomUUID()}`);
      await fs.rename(target, backup);
      replaced = true;
    }

    try {
      await fs.rename(tempTarget, target);
    } catch (error) {
      if (backup) {
        try {
          await fs.rename(backup, target);
          backup = null;
        } catch {
          // The finally block will try once more while the backup still exists.
        }
      }
      fail(
        `Could not publish skill "${name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        "SKILL_PUBLISH_FAILED",
      );
    }

    try {
      await writeLockfile(lockfilePath, withLockEntry(lock, name, {
        ...manifest,
      }));
    } catch (error) {
      await removePath(target);
      if (backup) {
        try {
          await fs.rename(backup, target);
          backup = null;
        } catch {
          // The finally block will try once more while the backup still exists.
        }
      }
      fail(
        `Could not update skills.lock.json; the previous skill was restored: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "SKILL_LOCK_WRITE_FAILED",
      );
    }

    if (backup) {
      await removePath(backup);
      backup = null;
    }

    return {
      name,
      path: target,
      source: parsed.source,
      requested: parsed.requested,
      trust: "user-approved",
      contentHash: validated.contentHash,
      hash: shortHash(validated.contentHash),
      previousHash,
      changed: previousHash === null || previousHash !== validated.contentHash,
      replaced,
      version: manifest.version,
      installedAt,
      existingLock,
    };
  } finally {
    if (tempTarget) await removePath(tempTarget);
    if (backup) {
      // A failed publish must leave the old target in place. If restoration
      // itself failed, keep the hidden backup for manual recovery instead of
      // deleting the only copy.
      if (target && !fsSync.existsSync(target)) {
        await fs.rename(backup, target).catch(() => {});
      }
    }
    await removePath(staging);
    // The staging root can accumulate empty directories after crashes; remove
    // it opportunistically. It is recreated on the next install.
    try {
      const remaining = await fs.readdir(stagingRoot);
      if (remaining.length === 0) await fs.rmdir(stagingRoot);
    } catch {
      // Ignore.
    }
  }
}

/** Remove one user-installed skill and its lock entry. */
export async function removeSkill({
  name,
  userRoot = path.join(dataDir(), "skills"),
  lockfilePath = path.join(dataDir(), "skills.lock.json"),
} = {}) {
  validateSkillName(name);
  const lock = await readLockfile(lockfilePath);
  const target = path.join(userRoot, name);
  if (!isInside(userRoot, target)) {
    fail("Skill path escapes the user skills directory.", "SKILL_PATH_ESCAPE");
  }

  const exists = fsSync.existsSync(target);
  if (!exists && !lock.skills[name]) {
    fail(`Skill "${name}" is not installed.`, "SKILL_NOT_FOUND");
  }

  let backup = null;
  if (exists) {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) {
      fail("Refusing to remove a symlinked skill directory.", "SKILL_SYMLINK");
    }
    if (!stat.isDirectory()) {
      fail("Skill path is not a directory.");
    }
    backup = path.join(userRoot, `.remove-${name}-${randomUUID()}`);
    await fs.rename(target, backup);
  }

  try {
    await writeLockfile(lockfilePath, withoutLockEntry(lock, name));
  } catch (error) {
    if (backup) await fs.rename(backup, target).catch(() => {});
    fail(
      `Could not update skills.lock.json; skill was not removed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "SKILL_LOCK_WRITE_FAILED",
    );
  }

  if (backup) await removePath(backup);
  return { name, removed: exists, trust: lock.skills[name]?.trust ?? null };
}

/** Reinstall using the provenance recorded in skills.lock.json. */
export async function updateSkill({
  name,
  userRoot = path.join(dataDir(), "skills"),
  builtinRoot = path.join(PACKAGE_ROOT, "src", "skills", "builtin"),
  lockfilePath = path.join(dataDir(), "skills.lock.json"),
  stagingRoot = path.join(dataDir(), "skills-staging"),
  knownTools = null,
  runSkillsCli = defaultRunSkillsCli,
  env = buildInstallerEnv(),
  cliVersion = SKILLS_CLI_VERSION,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
} = {}) {
  validateSkillName(name);
  const lock = await readLockfile(lockfilePath);
  const entry = lock.skills[name];
  if (!entry) {
    fail(`Skill "${name}" is not installed or has no lock entry.`, "SKILL_NOT_FOUND");
  }
  const source = entry.source ?? entry.requested;
  if (!source) {
    fail(`Skill "${name}" has no recorded source to update from.`, "SKILL_SOURCE_INVALID");
  }
  const parsed = parseSkillSource(source, { skill: name });
  const result = await installSkill({
    source: parsed.source,
    skill: parsed.skill ?? name,
    trust: "user-approved",
    userRoot,
    builtinRoot,
    lockfilePath,
    stagingRoot,
    knownTools,
    runSkillsCli,
    env,
    cliVersion,
    timeoutMs,
  });
  return { ...result, previousHash: entry.contentHash ?? result.previousHash };
}
