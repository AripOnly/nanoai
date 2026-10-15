// src/tools/write/write.js
//
// Full-file writer with directory creation. Ported from opencode's
// packages/opencode/src/tool/write.ts (read-only reference).
//
// Differences from opencode (documented, not accidental):
// - No permission popup and no formatter/LSP passes (no such infra in nano).
// - The unified diff is returned in the result so changes stay reviewable.
// - Partial edits belong to the edit tool; write always replaces whole files.
// - Adds an explicit `mkdir` mode because nano has no other folder-creation
//   tool besides shell; parent directories are always created as needed.
// - Relative paths anchor at the default save folder (nano-workspace);
//   absolute paths may point anywhere when the user names a location.

import path from "node:path";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createTwoFilesPatch, diffLines } from "diff";
import { trimDiff } from "#src/tools/edit.js";
import { resolveWorkspaceRoot } from "#src/tools/shared/workspace.js";

export const writeTool = {
  type: "function",
  name: "write",
  description:
    "Writes a file to the local filesystem. " +
    "Usage: " +
    "This tool will overwrite the existing file if there is one at the provided path. " +
    "If this is an existing file, you MUST use the read tool first to read the file's contents. " +
    "ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required. " +
    "Set mkdir to true ONLY to create a directory (a path with NO file extension, e.g. 'test' or 'docs'). " +
    "To create a FILE (e.g. 'test.txt', 'test/test.txt'), OMIT mkdir (or set false) and provide content. " +
    "Parent directories are created automatically. " +
    "NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested. " +
    "Only use emojis if explicitly requested.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      filePath: {
        type: "string",
        description: "The file or directory path to write. Relative paths resolve against the default save folder (nano-workspace); absolute paths may point anywhere.",
      },
      content: {
        type: "string",
        description: "The content to write to the file. Required unless mkdir is true.",
      },
      mkdir: {
        type: "boolean",
        description: "Set true ONLY for directories (no file extension). Omit/false for files.",
      },
    },
    required: ["filePath"],
  },
};

function fail(error) {
  return { success: false, error };
}

function resolveWritePath(filePath) {
  const root = resolveWorkspaceRoot();
  // Bebas: relatif jangkar ke default-save (nano-workspace), absolut boleh ke mana saja
  // (mis. Desktop) saat user menyebut lokasi eksplisit.
  return path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(root, filePath);
}

export async function write(params = {}, context = {}) {
  void context;
  try {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return fail("Parameters must be an object with 'filePath', optional 'content' and 'mkdir'.");
    }
    const { filePath, content, mkdir: makeDir = false } = params;
    if (typeof filePath !== "string" || filePath.trim() === "") {
      return fail("Parameter 'filePath' must be a non-empty string.");
    }
    if (makeDir !== undefined && typeof makeDir !== "boolean") {
      return fail("Parameter 'mkdir' must be a boolean when provided.");
    }
    if (!makeDir && typeof content !== "string") {
      return fail("Parameter 'content' must be a string when writing a file.");
    }

    let resolved;
    try {
      resolved = resolveWritePath(filePath);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    if (makeDir === true) {
      // Pengaman: path ber-ekstensi file (test.txt) + mkdir:true = pasti salah paham model.
      // Tolak dengan pesan jelas, bukan diam-diam bikin folder bernama "test.txt".
      if (/\.(txt|md|markdown|json|js|jsx|ts|tsx|py|docx|xlsx|xls|csv|html|css|log)$/i.test(path.basename(filePath))) {
        return fail(
          `Parameter 'mkdir' is true but filePath '${filePath}' looks like a FILE (has a file extension). ` +
            "To create a file, omit 'mkdir' (or set false) and provide 'content'. Use mkdir:true only for directories (no extension).",
        );
      }
      try {
        await mkdir(resolved, { recursive: true });
      } catch (error) {
        return fail(`Cannot create directory: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { success: true, output: `Directory created: ${resolved}`, created: true };
    }

    const existed = fs.statSync(resolved, { throwIfNoEntry: false });
    if (existed && !existed.isFile()) {
      return fail(`Path is a directory, not a file: ${filePath}. Set mkdir to true to create directories.`);
    }
    const contentOld = existed ? fs.readFileSync(resolved, "utf8") : "";
    const contentNew = content;

    try {
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, contentNew, "utf8");
    } catch (error) {
      return fail(`Cannot write file: ${error instanceof Error ? error.message : String(error)}`);
    }

    const diff = trimDiff(createTwoFilesPatch(resolved, resolved, contentOld, contentNew));
    let additions = 0;
    let deletions = 0;
    for (const change of diffLines(contentOld, contentNew)) {
      if (change.added) additions += change.count ?? 0;
      if (change.removed) deletions += change.count ?? 0;
    }
    return {
      success: true,
      output: "Wrote file successfully.",
      diff,
      additions,
      deletions,
      created: !existed,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
