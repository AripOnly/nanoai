// src/tools/workspace.js

import fs from "node:fs";
import os from "node:os";
import path from "path";

// Default workspace folder inside the user's home. Files and folders the
// agent creates without an explicit location land here instead of directly
// in home, keeping the home directory tidy.
const DEFAULT_WORKSPACE_DIR = "nano-workspace";

/**
 * Resolve a tool-provided path. Boot default save folder is ~/nano-workspace
 * (stable for 24/7 operation no matter where the gateway was launched from);
 * it is created on demand. Pin another root with the NANO_WORKSPACE environment
 * variable. Relative paths anchor at the save folder; absolute paths may point
 * anywhere when the user names a location. Per-call `workdir` on the shell tool
 * can still point anywhere, so the agent stays flexible. Throws a plain Error
 * so tool wrappers convert it into a `{ success: false, error }` result with a
 * clear message.
 *
 * `policy.allowOutsideRoot === false` confines the resolved path to the
 * workspace (including symlink targets). Read-only agents still default to
 * `true`; the switch exists for confined agents and future channels.
 */
export function resolveWorkspaceRoot() {
  const configured = process.env.NANO_WORKSPACE;
  if (configured && configured.trim() !== "") {
    const root = path.resolve(configured);
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch {
      // Creation failure surfaces later as a clear tool error, not here.
    }
    return root;
  }
  const root = path.join(os.homedir(), DEFAULT_WORKSPACE_DIR);
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    // Creation failure surfaces later as a clear tool error, not here.
  }
  return root;
}

export function resolveHomeDir() {
  return os.homedir();
}

/**
 * "Did you mean?" suggestions: up to 3 sibling names resembling the missing
 * target. Shared by read/glob/grep so every miss guides the model instead
 * of dead-ending it.
 */
export function suggestSimilarPaths(targetPath, max = 3) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath).toLowerCase();
  if (base === "") return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((item) => {
        const lower = item.toLowerCase();
        return lower.includes(base) || base.includes(lower);
      })
      .map((item) => path.join(dir, item))
      .slice(0, max);
  } catch {
    return [];
  }
}

// Resolve through symlinks where possible. For a path that does not exist yet
// (a new file), resolve the nearest existing ancestor and append the rest, so
// a symlinked parent directory cannot be used to escape the workspace.
function realPathForContainment(targetPath) {
  let current = path.resolve(targetPath);
  const rest = [];
  while (true) {
    try {
      const real = fs.realpathSync.native(current);
      return rest.length === 0 ? real : path.join(real, ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(targetPath);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Enforce `policy.allowOutsideRoot === false`. Returns the original path when
 * allowed, otherwise throws a tool-safe Error. Lexical containment alone is
 * not enough: existing symlinks/junctions and symlinked parents are resolved
 * before comparing against the workspace root.
 */
export function assertInsideWorkspace(targetPath, policy = {}) {
  if (policy?.allowOutsideRoot !== false) return targetPath;

  const root = resolveWorkspaceRoot();
  const rootReal = realPathForContainment(root);
  const targetReal = realPathForContainment(targetPath);
  const relative = path.relative(rootReal, targetReal);
  const outside =
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);

  if (outside) {
    throw new Error(
      `Access denied: path is outside the workspace root (${targetPath}).`,
    );
  }
  return targetPath;
}

export function resolveWorkspacePath(filePath, policy = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("Parameter 'path' must be a non-empty string.");
  }

  const root = resolveWorkspaceRoot();
  // Bebas: relative paths anchor at the default save folder (never the launch
  // directory) so every tool resolves the same relative path identically.
  // Absolute paths may point anywhere when the user names a location; a
  // restrictive policy turns that into a clear denial instead.
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(root, path.normalize(filePath));
  return assertInsideWorkspace(resolved, policy);
}
