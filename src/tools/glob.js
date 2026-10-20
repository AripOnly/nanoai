// src/tools/glob.js
//
// Fast file-pattern search over the workspace.
//
// Nano has no popup permission system (approval happens in conversation),
// and listing file names is read-only, so this tool runs directly like the read tool.

import path from "node:path";
import fs from "node:fs";
import { fail, resolveWorkspacePath, rgGlob, resolveWorkspaceRoot, suggestSimilarPaths } from "#src/tools/shared/index.js";

const RESULT_LIMIT = 100;

export const globTool = {
  type: "function",
  name: "glob",
  description:
    "Fast file pattern matching tool that works with any codebase size. " +
    "Supports glob patterns like '**/*.js' or 'src/**/*.ts'. " +
    "Returns matching file paths. " +
    "If nothing is found, check the searched directory in the result and retry with an absolute path. " +
    "Use this tool when you need to find files by name patterns. " +
    "You have the capability to call multiple tools in a single response. " +
    "It is always better to speculatively perform multiple searches as a batch that are potentially useful.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: {
        type: "string",
        description: "The glob pattern to match files against.",
      },
      path: {
        type: "string",
        description:
          "The directory to search in. Defaults to the workspace root. " +
          "Relative paths resolve against the workspace root; absolute paths may point anywhere.",
      },
    },
    required: ["pattern"],
  },
};

// fail() lives in #src/tools/shared/fail.js (imported above).

/**
 * Resolve the search directory. Relative paths anchor at the workspace root
 * (stable home default) so results never depend on the launch directory.
 * Absolute paths may point anywhere because listing names is read-only.
 */
function resolveSearchDir(searchPath, policy) {
  if (searchPath === undefined) {
    return resolveWorkspaceRoot();
  }
  return resolveWorkspacePath(searchPath, policy);
}

export async function glob(params = {}, context = {}) {
  try {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return fail("Parameters must be an object with 'pattern' and optional 'path'.");
    }
    const { pattern, path: searchPath } = params;
    if (typeof pattern !== "string" || pattern.trim() === "") {
      return fail("Parameter 'pattern' must be a non-empty string.");
    }

    let search;
    try {
      search = resolveSearchDir(searchPath, context.policy);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    let stat;
    try {
      stat = fs.statSync(search);
    } catch {
      const hints = suggestSimilarPaths(search);
      const hint = hints.length > 0 ? `\n\nDid you mean one of these?\n${hints.join("\n")}` : "";
      return fail(`Search directory does not exist: ${searchPath ?? search}${hint}`);
    }
    if (!stat.isDirectory()) {
      return fail(`Search path must be a directory: ${searchPath ?? search}`);
    }

    let found;
    try {
      found = await rgGlob({ cwd: search, pattern, limit: RESULT_LIMIT, signal: context.signal });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    if (found.files.length === 0) {
      // Always state WHERE nothing was found so the model can retry with an
      // absolute path instead of guessing other patterns blindly.
      return { success: true, output: `No files found in ${search}`, count: 0, truncated: false };
    }

    const output = found.files.map((file) => path.resolve(search, file));
    if (found.truncated) {
      output.push("");
      output.push(
        `(Results are truncated: showing first ${RESULT_LIMIT} results. Consider using a more specific path or pattern.)`,
      );
    }
    return {
      success: true,
      output: output.join("\n"),
      count: found.files.length,
      truncated: found.truncated,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
