// src/tools/grep.js
//
// Fast content search over the workspace.
//
// Nano has no popup permission system (approval happens in conversation),
// and content search is read-only, so this tool runs directly like the read tool.

import path from "node:path";
import fs from "node:fs";
import { rgGrep } from "#src/tools/shared/rg.js";
import { resolveWorkspaceRoot, suggestSimilarPaths } from "#src/tools/shared/workspace.js";

const RESULT_LIMIT = 100;

export const grepTool = {
  type: "function",
  name: "grep",
  description:
    "Fast content search with regex across files. Returns matches grouped by file " +
    "with line numbers. " +
    "If nothing is found, check the searched path in the result and retry with an absolute path. " +
    "Use this tool when you need to find code, symbols, or text inside files. " +
    "You have the capability to call multiple tools in a single response. " +
    "It is always better to speculatively perform multiple searches as a batch that are potentially useful.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: {
        type: "string",
        description: "The regex pattern to search for.",
      },
      path: {
        type: "string",
        description:
          "The directory or file to search in. Defaults to the workspace root. " +
          "Relative paths resolve against the workspace root; absolute paths may point anywhere.",
      },
      include: {
        type: "string",
        description: "Optional glob to restrict which files are searched (e.g. '*.js').",
      },
    },
    required: ["pattern"],
  },
};

function fail(error) {
  return { success: false, error };
}

/**
 * Resolve the search target. Relative paths anchor at the workspace root
 * (stable home default) so results never depend on the launch directory.
 * Absolute paths may point anywhere because content search is read-only.
 * Returns { cwd, file } where file is set when the target is a single file.
 */
function resolveSearchTarget(searchPath) {
  const root = resolveWorkspaceRoot();
  if (searchPath === undefined) {
    return { cwd: root, file: undefined, display: root };
  }
  if (typeof searchPath !== "string" || searchPath.trim() === "") {
    throw new Error("Parameter 'path' must be a non-empty string when provided.");
  }
  const resolved = path.isAbsolute(searchPath) ? path.normalize(searchPath) : path.resolve(root, searchPath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    const hints = suggestSimilarPaths(resolved);
    const hint = hints.length > 0 ? `\n\nDid you mean one of these?\n${hints.join("\n")}` : "";
    throw new Error(`Search path does not exist: ${searchPath}${hint}`);
  }
  if (stat.isFile()) {
    return { cwd: path.dirname(resolved), file: path.basename(resolved), display: resolved };
  }
  if (!stat.isDirectory()) {
    throw new Error(`Search path must be a file or directory: ${searchPath}`);
  }
  return { cwd: resolved, file: undefined, display: resolved };
}

export async function grep(params = {}, context = {}) {
  try {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return fail("Parameters must be an object with 'pattern' and optional 'path'/'include'.");
    }
    const { pattern, path: searchPath, include } = params;
    if (typeof pattern !== "string" || pattern.trim() === "") {
      return fail("Parameter 'pattern' must be a non-empty string.");
    }
    if (include !== undefined && (typeof include !== "string" || include.trim() === "")) {
      return fail("Parameter 'include' must be a non-empty string when provided.");
    }

    let target;
    try {
      target = resolveSearchTarget(searchPath);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    let found;
    try {
      found = await rgGrep({ cwd: target.cwd, pattern, include, file: target.file, limit: RESULT_LIMIT, signal: context.signal });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (found.invalidPattern) {
      return fail(`Invalid regex pattern: ${found.invalidPattern}`);
    }

    if (found.matches.length === 0) {
      // Always state WHERE nothing was found so the model can retry with an
      // absolute path instead of guessing other patterns blindly.
      return { success: true, output: `No files found in ${target.display}`, matches: 0, truncated: false };
    }

    const byFile = new Map();
    for (const match of found.matches) {
      const list = byFile.get(match.path) ?? [];
      list.push(match);
      byFile.set(match.path, list);
    }
    const total = found.matches.length;
    const sections = [`Found ${total} match${total === 1 ? "" : "es"} in ${target.display}`];
    for (const [file, matches] of byFile) {
      sections.push(`\n${file}:`);
      for (const match of matches) {
        sections.push(`  Line ${match.line}: ${match.text}`);
      }
    }
    if (found.truncated) {
      sections.push(
        "",
        `(Results are truncated: showing first ${RESULT_LIMIT} results. Consider using a more specific path or pattern.)`,
      );
    }
    return {
      success: true,
      output: sections.join("\n"),
      matches: total,
      truncated: found.truncated,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
