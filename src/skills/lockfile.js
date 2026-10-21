// src/skills/lockfile.js
//
// The lockfile records provenance and the integrity hash for installed skills.
// It is metadata, never instruction: the body always comes from SKILL.md.
// Writes are atomic because a half-written lockfile would make every installed
// skill look untrusted after a crash.

import fs from "node:fs/promises";
import { writeFileAtomic } from "#src/infra/secure-file.js";
import { SkillError } from "./loader.js";

const LOCK_VERSION = 1;

function fail(message) {
  throw new SkillError(message, "SKILL_LOCK_INVALID");
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalizeEntry(entry, name) {
  if (!isPlainObject(entry)) fail(`Lock entry for "${name}" must be an object.`);
  const trust = entry.trust ?? "external";
  if (!["builtin", "user-approved", "external"].includes(trust)) {
    fail(`Lock entry for "${name}" has an invalid trust value.`);
  }
  const contentHash = optionalString(entry.contentHash);
  if (contentHash !== null && !/^sha256:[0-9a-f]{64}$/.test(contentHash)) {
    fail(`Lock entry for "${name}" has an invalid contentHash.`);
  }
  return Object.freeze({
    source: optionalString(entry.source),
    requested: optionalString(entry.requested),
    resolvedRef: optionalString(entry.resolvedRef),
    contentHash,
    version: optionalString(entry.version),
    installedAt: optionalString(entry.installedAt),
    skillsCliVersion: optionalString(entry.skillsCliVersion),
    trust,
    scanner: optionalString(entry.scanner) ?? "none",
    telemetryDisabled: entry.telemetryDisabled === true,
  });
}

export function emptyLockfile() {
  return { version: LOCK_VERSION, skills: {} };
}

/** Strict lockfile read. A broken lockfile must not be silently rewritten. */
export async function readLockfile(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyLockfile();
    throw error;
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("skills.lock.json is not valid JSON.");
  }
  if (!isPlainObject(raw)) fail("skills.lock.json must contain a JSON object.");
  if (raw.version !== undefined && raw.version !== LOCK_VERSION) {
    fail(`skills.lock.json version ${raw.version} is not supported.`);
  }
  if (!isPlainObject(raw.skills ?? {})) {
    fail("skills.lock.json skills must be an object.");
  }

  const skills = {};
  for (const [name, entry] of Object.entries(raw.skills ?? {})) {
    if (typeof name !== "string" || name === "") {
      fail("skills.lock.json contains an empty skill name.");
    }
    skills[name] = normalizeEntry(entry, name);
  }

  return Object.freeze({
    version: LOCK_VERSION,
    skills: Object.freeze(skills),
  });
}

/** Non-throwing read used by the registry so one bad lock cannot hide skills. */
export async function readLockfileSafe(filePath) {
  try {
    return { lock: await readLockfile(filePath), error: null };
  } catch (error) {
    return {
      lock: emptyLockfile(),
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export async function writeLockfile(filePath, lock) {
  const normalized = {
    version: LOCK_VERSION,
    skills: {},
  };
  for (const [name, entry] of Object.entries(lock?.skills ?? {})) {
    normalized.skills[name] = normalizeEntry(entry, name);
  }
  await writeFileAtomic(
    filePath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    { mode: 0o600 },
  );
  return normalized;
}

export function lockEntryFromManifest(manifest) {
  return {
    source: manifest.source,
    requested: manifest.requested,
    resolvedRef: manifest.resolvedRef,
    contentHash: manifest.contentHash,
    version: manifest.version,
    installedAt: manifest.installedAt,
    skillsCliVersion: manifest.skillsCliVersion,
    trust: manifest.trust,
    scanner: manifest.scanner ?? "none",
    telemetryDisabled: manifest.telemetryDisabled === true,
  };
}

export function withLockEntry(lock, name, entry) {
  return {
    version: LOCK_VERSION,
    skills: {
      ...(lock?.skills ?? {}),
      [name]: entry,
    },
  };
}

export function withoutLockEntry(lock, name) {
  const skills = { ...(lock?.skills ?? {}) };
  delete skills[name];
  return { version: LOCK_VERSION, skills };
}

export function shortHash(value) {
  if (typeof value !== "string") return null;
  if (value.startsWith("sha256:") && value.length >= 19) {
    return value.slice(7, 19);
  }
  return value.length > 12 ? value.slice(0, 12) : value;
}

export { LOCK_VERSION };
