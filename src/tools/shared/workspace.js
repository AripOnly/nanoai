// src/tools/workspace.js

import fs from "node:fs";
import os from "node:os";
import path from "path";

// Default workspace folder inside the user's home. Files and folders the
// agent creates without an explicit location land here instead of directly
// in home, keeping the home directory tidy.
const DEFAULT_WORKSPACE_DIR = "nano-workspace";

/**
 * Resolve a tool-provided path and guarantee it stays inside the workspace.
 * Boot default is ~/nano-workspace (stable for 24/7 operation no matter
 * where the gateway was launched from); it is created on demand. Pin another
 * root with the NANO_WORKSPACE environment variable. Per-call `workdir` on
 * the shell tool can still point anywhere, so the agent stays flexible.
 * Throws a plain Error so tool wrappers convert it into a
 * `{ success: false, error }` result with a clear message.
 */
export function resolveWorkspaceRoot() {
  const configured = process.env.NANO_WORKSPACE;
  if (configured && configured.trim() !== "") {
    return path.resolve(configured);
  }
  const root = path.join(os.homedir(), DEFAULT_WORKSPACE_DIR);
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    // Creation failure surfaces later as a clear tool error, not here.
  }
  return root;
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

export function resolveWorkspacePath(filePath) {  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("Parameter 'path' must be a non-empty string.");
  }

  const root = resolveWorkspaceRoot();
  // Relative paths anchor at the workspace root (never the launch directory),
  // so every tool resolves the same relative path identically. Absolute paths
  // still work when given, but must stay inside the root.
  const resolved = path.resolve(root, path.normalize(filePath));

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Path must stay inside the workspace.");
  }

  return resolved;
}
