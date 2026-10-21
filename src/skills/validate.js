// src/skills/validate.js
//
// Filesystem-level validation for skill trees. A skill is data on disk, so the
// important properties are structural: no symlinks, no traversal, bounded
// file count/size, and a deterministic content hash. Nothing here executes a
// skill file or follows a link outside the skill directory.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  SkillError,
  SKILL_MANIFEST_FILENAME,
  isInside,
  parseSkillManifest,
  readSkillDocument,
} from "./loader.js";

export const DEFAULT_MAX_SKILL_BYTES = 131072;
export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_TOTAL_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
export const MAX_STAGING_DEPTH = 10;

const IGNORED_NAMES = new Set([".git", "node_modules"]);

function fail(message, code = "SKILL_INVALID") {
  throw new SkillError(message, code);
}

function posixRelative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function shouldIgnore(name) {
  return IGNORED_NAMES.has(name) || name === SKILL_MANIFEST_FILENAME;
}

/**
 * Walk a skill tree without following links. Returned files are sorted by
 * POSIX relative path so hashing is stable across operating systems.
 */
export async function walkSkillTree(
  root,
  {
    maxFiles = MAX_SKILL_FILES,
    maxTotalBytes = MAX_SKILL_TOTAL_BYTES,
    maxFileBytes = MAX_SKILL_FILE_BYTES,
  } = {},
) {
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) {
    fail("Skill directory must not be a symlink.", "SKILL_SYMLINK");
  }
  if (!rootStat.isDirectory()) {
    fail("Skill path must be a directory.");
  }

  const files = [];
  let totalBytes = 0;

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;
      const full = path.join(directory, entry.name);
      const stat = await fs.lstat(full);

      if (stat.isSymbolicLink()) {
        fail(
          `Skill contains a symlink at ${posixRelative(root, full)}.`,
          "SKILL_SYMLINK",
        );
      }

      if (stat.isDirectory()) {
        await walk(full);
        continue;
      }

      if (!stat.isFile()) {
        fail(
          `Skill contains an unsupported file type at ${posixRelative(root, full)}.`,
        );
      }

      if (stat.size > maxFileBytes) {
        fail(
          `Skill file ${posixRelative(root, full)} is too large (${stat.size} bytes, limit ${maxFileBytes}).`,
          "SKILL_TOO_LARGE",
        );
      }
      totalBytes += stat.size;
      if (totalBytes > maxTotalBytes) {
        fail(
          `Skill tree is too large (limit ${maxTotalBytes} bytes).`,
          "SKILL_TOO_LARGE",
        );
      }
      files.push({
        path: posixRelative(root, full),
        size: stat.size,
        absolutePath: full,
      });
      if (files.length > maxFiles) {
        fail(`Skill contains too many files (limit ${maxFiles}).`, "SKILL_TOO_LARGE");
      }
    }
  }

  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files, totalBytes };
}

/** SHA-256 over (relative path, size, bytes) for every file, in sorted order. */
export async function hashSkillTree(tree) {
  const hash = createHash("sha256");
  for (const file of tree.files) {
    const bytes = await fs.readFile(file.absolutePath);
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Validate a directory containing SKILL.md at its root.
 *
 * This is the installer gate and also the registry's normal scan gate. It
 * returns metadata but never mutates the tree.
 */
export async function validateSkillTree(
  root,
  {
    maxSkillBytes = DEFAULT_MAX_SKILL_BYTES,
    maxFiles = MAX_SKILL_FILES,
    maxTotalBytes = MAX_SKILL_TOTAL_BYTES,
    maxFileBytes = MAX_SKILL_FILE_BYTES,
    knownTools = null,
  } = {},
) {
  const tree = await walkSkillTree(root, {
    maxFiles,
    maxTotalBytes,
    maxFileBytes,
  });

  const skillFile = tree.files.find((file) => file.path === "SKILL.md");
  if (!skillFile) {
    fail("Skill directory must contain SKILL.md at its root.");
  }
  if (skillFile.size > maxSkillBytes) {
    fail(
      `SKILL.md is too large (${skillFile.size} bytes, limit ${maxSkillBytes}).`,
      "SKILL_TOO_LARGE",
    );
  }

  const document = await readSkillDocument(skillFile.absolutePath, {
    maxBytes: maxSkillBytes,
    knownTools,
  });

  const manifestPath = path.join(root, SKILL_MANIFEST_FILENAME);
  let manifest = null;
  try {
    const stat = await fs.lstat(manifestPath);
    if (stat.isSymbolicLink()) {
      fail("Skill manifest must not be a symlink.", "SKILL_SYMLINK");
    }
    if (!stat.isFile()) {
      fail("Skill manifest must be a regular file.", "SKILL_MANIFEST_INVALID");
    }
    manifest = parseSkillManifest(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const contentHash = await hashSkillTree(tree);
  return {
    root,
    document,
    manifest,
    contentHash,
    files: tree.files.map((file) => ({ path: file.path, size: file.size })),
    totalBytes: tree.totalBytes,
    supportingFiles: tree.files
      .filter((file) => file.path !== "SKILL.md")
      .map((file) => ({ path: file.path, size: file.size })),
  };
}

/**
 * Find roots containing SKILL.md under a staging directory. Once a directory
 * contains a skill we stop descending so sample files inside a skill cannot be
 * mistaken for a second skill.
 */
export async function findSkillRoots(root, { maxDepth = MAX_STAGING_DEPTH } = {}) {
  const found = [];

  async function walk(directory, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const hasSkill = entries.some(
      (entry) => entry.name === "SKILL.md" && entry.isFile(),
    );
    if (hasSkill) {
      found.push(directory);
      return;
    }
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      if (!entry.isDirectory()) continue;
      const full = path.join(directory, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) continue;
      await walk(full, depth + 1);
    }
  }

  await walk(root, 0);
  return found;
}

/** Copy a validated skill tree, excluding provenance and VCS/build folders. */
export async function copySkillTree(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    preserveTimestamps: false,
    filter: (src) => {
      const name = path.basename(src);
      return !shouldIgnore(name) && !IGNORED_NAMES.has(name);
    },
  });
}

function sanitizeRelative(relative) {
  if (typeof relative !== "string" || relative.trim() === "") {
    fail("Supporting file path must be a non-empty string.");
  }
  if (relative.length > 512 || relative.includes("\0")) {
    fail("Supporting file path is invalid.");
  }
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    fail("Supporting file path must be relative to the skill directory.");
  }
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    fail("Supporting file path must not escape the skill directory.");
  }
  return parts.join(path.sep);
}

/**
 * Read one supporting file, bounded and confined to the skill directory.
 * Symlinks and traversal are rejected even if the registry was built on a
 * different platform than the one serving the request.
 */
export async function readSupportingFile(
  skillRoot,
  relative,
  { maxBytes = 16384 } = {},
) {
  const safe = sanitizeRelative(relative);
  const root = path.resolve(skillRoot);
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) {
    fail("Skill directory must not be a symlink.", "SKILL_SYMLINK");
  }
  if (!rootStat.isDirectory()) {
    fail("Skill path is not a directory.");
  }
  const target = path.resolve(root, safe);
  if (!isInside(root, target)) {
    fail("Supporting file path escapes the skill directory.", "SKILL_PATH_ESCAPE");
  }

  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) {
    fail("Supporting files must not be symlinks.", "SKILL_SYMLINK");
  }
  if (!stat.isFile()) {
    fail("Supporting path is not a regular file.");
  }

  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(target);
  if (!isInside(realRoot, realTarget)) {
    fail("Supporting file path escapes the skill directory.", "SKILL_PATH_ESCAPE");
  }

  if (stat.size > maxBytes) {
    fail(
      `Supporting file is too large (${stat.size} bytes, limit ${maxBytes}).`,
      "SKILL_TOO_LARGE",
    );
  }

  const bytes = await fs.readFile(target);
  if (bytes.subarray(0, 8192).includes(0)) {
    fail("Supporting file is binary; only text files can be loaded.");
  }
  return {
    path: safe.split(path.sep).join("/"),
    size: bytes.length,
    content: bytes.toString("utf8"),
  };
}
