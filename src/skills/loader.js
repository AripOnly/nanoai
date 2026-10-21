// src/skills/loader.js
//
// SKILL.md is data, never code. This module parses the frontmatter contract
// and normalizes it into a small, frozen description the registry can trust.
// It deliberately knows nothing about the filesystem layout or the runtime:
// callers supply the known tool names so `allowed-tools` can only narrow.

import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export class SkillError extends Error {
  constructor(message, code = "SKILL_INVALID") {
    super(message);
    this.name = "SkillError";
    this.code = code;
  }
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_DESCRIPTION_CHARS = 1000;
export const MAX_LIST_ITEMS = 50;

const SKILL_MANIFEST = ".nanoai-skill.json";
const TRUST_VALUES = new Set(["builtin", "user-approved", "external"]);

// skills.sh publishes skills written for several agent environments. Accept
// the common Claude-style aliases but always store NanoAI's canonical tool
// names; a skill can never introduce a tool that the agent does not have.
const TOOL_ALIASES = Object.freeze({
  bash: "shell",
  shell: "shell",
  read: "read",
  write: "write",
  edit: "edit",
  multiedit: "edit",
  glob: "glob",
  grep: "grep",
  webfetch: "webFetch",
  websearch: "webSearch",
  writeword: "writeWord",
  writeexcel: "writeExcel",
  process: "process",
});

function fail(message, code = "SKILL_INVALID") {
  throw new SkillError(message, code);
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value, field, { maxItems = MAX_LIST_ITEMS } = {}) {
  if (value === undefined || value === null) return [];
  let items;
  if (typeof value === "string") {
    items = value.split(",");
  } else if (Array.isArray(value)) {
    items = value;
  } else {
    fail(`${field} must be a string or an array of strings.`);
  }

  const result = [];
  for (const item of items) {
    if (typeof item !== "string") {
      fail(`${field} must contain only strings.`);
    }
    const value = item.trim();
    if (value === "") continue;
    if (value.length > 160) {
      fail(`${field} entries must be at most 160 characters.`);
    }
    if (!result.includes(value)) result.push(value);
  }
  if (result.length > maxItems) {
    fail(`${field} must contain at most ${maxItems} entries.`);
  }
  return result;
}

function canonicalToolName(raw, knownTools) {
  const value = raw.trim();
  if (value === "") return null;
  // Claude-style `Bash(git:*)` and similar capability expressions narrow to
  // the underlying tool family. NanoAI does not implement per-command grants.
  const base = value.replace(/\(.*\)$/, "").trim().toLowerCase();
  const mapped = Object.hasOwn(TOOL_ALIASES, base)
    ? TOOL_ALIASES[base]
    : base;
  if (mapped == null) {
    fail(`allowed-tools entry "${value}" is not supported by NanoAI.`);
  }

  if (knownTools != null) {
    const known = new Map(
      knownTools.map((name) => [String(name).toLowerCase(), String(name)]),
    );
    const resolved = known.get(mapped.toLowerCase());
    if (!resolved) {
      fail(`allowed-tools entry "${value}" is not a known NanoAI tool.`);
    }
    return resolved;
  }
  return mapped;
}

function normalizeAllowedTools(value, knownTools) {
  const tools =
    typeof value === "string" && !value.includes(",")
      ? value.split(/\s+/).filter(Boolean)
      : stringList(value, "allowed-tools", { maxItems: 32 });
  const result = [];
  for (const tool of tools) {
    const canonical = canonicalToolName(tool, knownTools);
    if (canonical && !result.includes(canonical)) result.push(canonical);
  }
  return result;
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) {
    return {
      version: null,
      os: [],
      tags: [],
      triggers: [],
      autoLoad: false,
      requires: { env: [], bins: [] },
    };
  }
  if (!isPlainObject(value)) {
    fail("metadata must be a YAML mapping.");
  }

  const requires = value.requires ?? {};
  if (!isPlainObject(requires)) {
    fail("metadata.requires must be a YAML mapping.");
  }

  const autoLoad = value.autoLoad ?? value.auto_load ?? false;
  if (typeof autoLoad !== "boolean") {
    fail("metadata.autoLoad must be a boolean.");
  }

  const version = text(value.version);
  if (version.length > 128) {
    fail("metadata.version must be at most 128 characters.");
  }

  return {
    version: version || null,
    os: stringList(value.os, "metadata.os", { maxItems: 8 }),
    tags: stringList(value.tags, "metadata.tags"),
    triggers: stringList(value.triggers, "metadata.triggers"),
    autoLoad,
    requires: {
      env: stringList(requires.env, "metadata.requires.env", { maxItems: 16 }),
      bins: stringList(requires.bins, "metadata.requires.bins", { maxItems: 16 }),
    },
  };
}

/**
 * Parse one SKILL.md. The body is returned trimmed and is never executed.
 *
 * @param {string} source markdown text
 * @param {object} [options]
 * @param {string[]|null} [options.knownTools] canonical tool names; null skips
 *   the known-tool check (loader unit tests), an empty array rejects every tool.
 */
export function parseSkillMarkdown(source, { knownTools = null } = {}) {
  if (typeof source !== "string") {
    fail("SKILL.md must be text.");
  }

  const normalized = source.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);
  if (!match) {
    fail(
      "SKILL.md must start with YAML frontmatter delimited by two --- lines.",
    );
  }

  let raw;
  try {
    raw = parseYaml(match[1]);
  } catch (error) {
    fail(
      `SKILL.md frontmatter is not valid YAML: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!isPlainObject(raw)) {
    fail("SKILL.md frontmatter must be a YAML mapping.");
  }

  const name = text(raw.name);
  if (!name) fail("SKILL.md frontmatter is missing a non-empty name.");
  if (!SKILL_NAME_RE.test(name)) {
    fail(
      `Skill name "${name}" is unsafe. Use lowercase letters, digits, dot, underscore, or dash (max 64 chars).`,
    );
  }

  const description = text(raw.description);
  if (!description) {
    fail("SKILL.md frontmatter is missing a non-empty description.");
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    fail(
      `Skill description must be at most ${MAX_DESCRIPTION_CHARS} characters.`,
    );
  }

  const metadata = normalizeMetadata(raw.metadata);
  const allowedTools = normalizeAllowedTools(raw["allowed-tools"], knownTools);
  const body = normalized.slice(match[0].length).trim();

  return Object.freeze({
    name,
    description,
    body,
    allowedTools: Object.freeze(allowedTools),
    version: metadata.version,
    os: Object.freeze(metadata.os),
    tags: Object.freeze(metadata.tags),
    triggers: Object.freeze(metadata.triggers),
    autoLoad: metadata.autoLoad,
    requires: Object.freeze({
      env: Object.freeze(metadata.requires.env),
      bins: Object.freeze(metadata.requires.bins),
    }),
    attributes: Object.freeze({ ...raw }),
  });
}

/** Read and parse a SKILL.md while refusing symlinks and oversized files. */
export async function readSkillDocument(
  filePath,
  { maxBytes = 131072, knownTools = null } = {},
) {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) {
    fail("SKILL.md must not be a symlink.", "SKILL_SYMLINK");
  }
  if (!stat.isFile()) {
    fail("SKILL.md must be a regular file.");
  }
  if (stat.size > maxBytes) {
    fail(
      `SKILL.md is too large (${stat.size} bytes, limit ${maxBytes}).`,
      "SKILL_TOO_LARGE",
    );
  }

  const source = await fs.readFile(filePath, "utf8");
  return parseSkillMarkdown(source, { knownTools });
}

function manifestString(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`Skill manifest is missing ${field}.`, "SKILL_MANIFEST_INVALID");
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    fail(`Skill manifest ${field} must be a non-empty string.`, "SKILL_MANIFEST_INVALID");
  }
  return value.trim();
}

/**
 * Parse `.nanoai-skill.json`. This is provenance only; the SKILL.md body
 * remains the source of instructions.
 */
export function parseSkillManifest(source) {
  let raw;
  try {
    raw = typeof source === "string" ? JSON.parse(source) : source;
  } catch {
    fail("Skill manifest is not valid JSON.", "SKILL_MANIFEST_INVALID");
  }
  if (!isPlainObject(raw)) {
    fail("Skill manifest must be a JSON object.", "SKILL_MANIFEST_INVALID");
  }

  const trust = text(raw.trust) || "external";
  if (!TRUST_VALUES.has(trust)) {
    fail(`Skill manifest trust "${trust}" is invalid.`, "SKILL_MANIFEST_INVALID");
  }

  const contentHash = manifestString(raw.contentHash, "contentHash");
  if (contentHash !== null && !/^sha256:[0-9a-f]{64}$/.test(contentHash)) {
    fail("Skill manifest contentHash must be sha256:<hex>.", "SKILL_MANIFEST_INVALID");
  }

  return Object.freeze({
    source: manifestString(raw.source, "source"),
    requested: manifestString(raw.requested, "requested"),
    resolvedRef: manifestString(raw.resolvedRef, "resolvedRef"),
    contentHash,
    version: manifestString(raw.version, "version"),
    installedAt: manifestString(raw.installedAt, "installedAt"),
    skillsCliVersion: manifestString(raw.skillsCliVersion, "skillsCliVersion"),
    trust,
    scanner: manifestString(raw.scanner, "scanner") ?? "none",
    telemetryDisabled: raw.telemetryDisabled === true,
  });
}

export const SKILL_MANIFEST_FILENAME = SKILL_MANIFEST;

/** Safe path check used by supporting-file reads and installer copies. */
export function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(".." + path.sep) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}
