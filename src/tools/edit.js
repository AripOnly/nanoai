// src/tools/edit.js
//
// Exact string replacement in files.
//
// Design differences (documented, not accidental):
// - No permission popup: nano approvals happen in conversation, and the
//   unified diff is returned in the result so the model (and user) can review it.
// - No formatter/LSP passes: nano has no formatter or language-server infra.
// - Paths: relative anchors at the default save folder (nano-workspace),
//   absolute paths may point anywhere when the user names a location.
// - The "read before edit" rule from edit.txt cannot be enforced statelessly
//   here; the agent instruction already tells the model to read first.

import path from "node:path";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createTwoFilesPatch, diffLines } from "diff";
import { fail, resolveWorkspacePath, trimDiff } from "./shared/index.js";

// Kept as a re-export while callers migrate to #src/tools/shared/index.js.
export { trimDiff };

// Similarity threshold for fuzzy block matching.
const SIMILARITY_THRESHOLD = 0.65;

export const editTool = {
  type: "function",
  name: "edit",
  description:
    "Performs exact string replacements in files. " +
    "Usage: " +
    "You must use your `read` tool at least once in the conversation before editing. " +
    "When editing text from read tool output, preserve the exact indentation (tabs/spaces). " +
    "ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required. " +
    "The edit will FAIL if `oldString` is not found in the file. " +
    "The edit will FAIL if `oldString` is found multiple times in the file. " +
    "Either provide a larger string with more surrounding context to make it unique or use `replaceAll` to change every instance. " +
    "Use `replaceAll` for replacing and renaming strings across the file.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      filePath: {
        type: "string",
        description: "The path of the file to modify. Relative paths resolve against the default save folder (nano-workspace); absolute paths may point anywhere.",
      },
      oldString: {
        type: "string",
        description: "The text to replace. Use an empty string only to create a new file.",
      },
      newString: {
        type: "string",
        description: "The text to replace it with (must be different from oldString).",
      },
      replaceAll: {
        type: "boolean",
        description: "Replace all occurrences of oldString (default false).",
      },
    },
    required: ["filePath", "oldString", "newString"],
  },
};

// fail() lives in ./shared/fail.js (imported above).

// ---------------------------------------------------------------------------
// Per-file mutex. Concurrent edits to the same file are serialized through
// a promise chain so read-modify-write cycles never interleave and lose
// each other's changes.
// ---------------------------------------------------------------------------
const locks = new Map();

function withFileLock(filePath, task) {
  const previous = locks.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  locks.set(filePath, next);
  // Drop the entry once settled so the map never grows without bound.
  next.catch(() => {}).finally(() => {
    if (locks.get(filePath) === next) locks.delete(filePath);
  });
  return next;
}

// ---------------------------------------------------------------------------
// BOM helpers. A UTF-8 BOM is invisible in most editors; stripping it for the
// match and re-attaching it afterwards keeps edits byte-stable.
// ---------------------------------------------------------------------------
function splitBom(text) {
  if (text.charCodeAt(0) === 0xfeff) {
    return { bom: true, text: text.slice(1) };
  }
  return { bom: false, text };
}

function joinBom(text, bom) {
  // Explicit U+FEFF escape: never embed an invisible literal BOM character.
  return bom ? "\uFEFF" + text : text;
}

// ---------------------------------------------------------------------------
// Line endings. Matching always runs on \n-normalized text, but the file's
// original ending style is preserved on write.
// ---------------------------------------------------------------------------
function normalizeLineEndings(text) {
  return text.replaceAll("\r\n", "\n");
}

function detectLineEnding(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function convertToLineEnding(text, ending) {
  if (ending === "\n") return text;
  return text.replaceAll("\n", "\r\n");
}

// ---------------------------------------------------------------------------
// Fuzzy matchers. Each generator yields candidate spans from the file content
// that correspond to the requested oldString under some normalization.
// Order matters: exact match first, progressively fuzzier strategies after.
// ---------------------------------------------------------------------------
function levenshtein(a, b) {
  if (a === "" || b === "") {
    return Math.max(a.length, b.length);
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

// Yields line ranges as { startLine, endLine } for anchor-based matchers.
function anchorCandidates(originalLines, searchLines) {
  if (searchLines.length < 3) return [];
  const lines = [...searchLines];
  if (lines[lines.length - 1] === "") lines.pop();
  const first = lines[0].trim();
  const last = lines[lines.length - 1].trim();
  const maxDelta = Math.max(1, Math.floor(lines.length * 0.25));
  const candidates = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== first) continue;
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === last) {
        if (Math.abs(j - i + 1 - lines.length) <= maxDelta) {
          candidates.push({ startLine: i, endLine: j, searchLines: lines });
        }
        break;
      }
    }
  }
  return candidates;
}

function sliceLines(content, originalLines, startLine, endLine) {
  let start = 0;
  for (let k = 0; k < startLine; k++) start += originalLines[k].length + 1;
  let end = start;
  for (let k = startLine; k <= endLine; k++) {
    end += originalLines[k].length;
    if (k < endLine) end += 1;
  }
  return content.substring(start, end);
}

function* simpleReplacer(_content, find) {
  yield find;
}

function* lineTrimmedReplacer(content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");
  if (searchLines[searchLines.length - 1] === "") searchLines.pop();
  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }
    if (matches) {
      yield sliceLines(content, originalLines, i, i + searchLines.length - 1);
    }
  }
}

function* blockAnchorReplacer(content, find) {
  const originalLines = content.split("\n");
  const candidates = anchorCandidates(originalLines, find.split("\n"));
  if (candidates.length === 0) return;
  const score = (candidate) => {
    const { startLine, endLine, searchLines } = candidate;
    const actual = endLine - startLine + 1;
    const count = Math.min(searchLines.length - 2, actual - 2);
    if (count <= 0) return 1;
    let similarity = 0;
    for (let j = 1; j < searchLines.length - 1 && j < actual - 1; j++) {
      const a = originalLines[startLine + j].trim();
      const b = searchLines[j].trim();
      const maxLen = Math.max(a.length, b.length);
      if (maxLen === 0) continue;
      similarity += (1 - levenshtein(a, b) / maxLen) / count;
      if (candidates.length === 1 && similarity >= SIMILARITY_THRESHOLD) break;
    }
    return similarity;
  };
  if (candidates.length === 1) {
    if (score(candidates[0]) >= SIMILARITY_THRESHOLD) {
      yield sliceLines(content, originalLines, candidates[0].startLine, candidates[0].endLine);
    }
    return;
  }
  let best = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const similarity = score(candidate);
    if (similarity > bestScore) {
      bestScore = similarity;
      best = candidate;
    }
  }
  if (best && bestScore >= SIMILARITY_THRESHOLD) {
    yield sliceLines(content, originalLines, best.startLine, best.endLine);
  }
}

function* whitespaceNormalizedReplacer(content, find) {
  const normalize = (text) => text.replace(/\s+/g, " ").trim();
  const normalizedFind = normalize(find);
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (normalize(lines[i]) === normalizedFind) {
      yield lines[i];
      continue;
    }
    if (normalize(lines[i]).includes(normalizedFind)) {
      const words = find.trim().split(/\s+/);
      if (words.length > 0) {
        const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
        try {
          const match = lines[i].match(new RegExp(pattern));
          if (match) yield match[0];
        } catch {
          // Invalid regex pattern, skip.
        }
      }
    }
  }
  const findLines = find.split("\n");
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join("\n");
      if (normalize(block) === normalizedFind) yield block;
    }
  }
}

function* indentationFlexibleReplacer(content, find) {
  const removeIndent = (text) => {
    const lines = text.split("\n");
    const nonEmpty = lines.filter((line) => line.trim().length > 0);
    if (nonEmpty.length === 0) return text;
    const min = Math.min(...nonEmpty.map((line) => line.match(/^(\s*)/)?.[1].length ?? 0));
    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(min))).join("\n");
  };
  const normalizedFind = removeIndent(find);
  const contentLines = content.split("\n");
  const findLines = find.split("\n");
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n");
    if (removeIndent(block) === normalizedFind) yield block;
  }
}

function* escapeNormalizedReplacer(content, find) {
  const unescape = (str) =>
    str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, char) => {
      switch (char) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case "'":
          return "'";
        case '"':
          return '"';
        case "`":
          return "`";
        case "\\":
          return "\\";
        case "\n":
          return "\n";
        case "$":
          return "$";
        default:
          return match;
      }
    });
  const unescapedFind = unescape(find);
  if (content.includes(unescapedFind)) yield unescapedFind;
  const lines = content.split("\n");
  const findLines = unescapedFind.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (unescape(block) === unescapedFind) yield block;
  }
}

function* multiOccurrenceReplacer(content, find) {
  // Yields every exact occurrence so the replace step can apply replaceAll.
  let from = 0;
  while (true) {
    const index = content.indexOf(find, from);
    if (index === -1) break;
    yield find;
    from = index + find.length;
  }
}

function* trimmedBoundaryReplacer(content, find) {
  const trimmed = find.trim();
  if (trimmed === find) return;
  if (content.includes(trimmed)) yield trimmed;
  const lines = content.split("\n");
  const findLines = find.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (block.trim() === trimmed) yield block;
  }
}

function* contextAwareReplacer(content, find) {
  const findLines = find.split("\n");
  if (findLines.length < 3) return;
  if (findLines[findLines.length - 1] === "") findLines.pop();
  const contentLines = content.split("\n");
  const first = findLines[0].trim();
  const last = findLines[findLines.length - 1].trim();
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== first) continue;
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() !== last) continue;
      const blockLines = contentLines.slice(i, j + 1);
      if (blockLines.length === findLines.length) {
        let matching = 0;
        let total = 0;
        for (let k = 1; k < blockLines.length - 1; k++) {
          const a = blockLines[k].trim();
          const b = findLines[k].trim();
          if (a.length > 0 || b.length > 0) {
            total++;
            if (a === b) matching++;
          }
        }
        if (total === 0 || matching / total >= 0.5) {
          yield blockLines.join("\n");
          break;
        }
      }
      break;
    }
  }
}

// Guards against a fuzzy matcher returning a span far larger than requested,
// which would otherwise delete unrelated code silently.
function isDisproportionateMatch(search, oldString) {
  const oldLines = oldString.split("\n").length;
  const searchLines = search.split("\n").length;
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  if (oldLines === 1) return false;
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4);
}

const REPLACERS = [
  simpleReplacer,
  lineTrimmedReplacer,
  blockAnchorReplacer,
  whitespaceNormalizedReplacer,
  indentationFlexibleReplacer,
  escapeNormalizedReplacer,
  trimmedBoundaryReplacer,
  contextAwareReplacer,
  multiOccurrenceReplacer,
];

export function replace(content, oldString, newString, replaceAll = false) {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.");
  }
  if (oldString === "") {
    throw new Error(
      "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
    );
  }

  let found = false;
  for (const replacer of REPLACERS) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search);
      if (index === -1) continue;
      found = true;
      if (isDisproportionateMatch(search, oldString)) {
        throw new Error(
          "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.",
        );
      }
      if (replaceAll) {
        return content.replaceAll(search, newString);
      }
      // Single mode only applies to a unique match; otherwise a later,
      // fuzzier replacer (or the multiple-match error) decides.
      if (index !== content.lastIndexOf(search)) continue;
      return content.substring(0, index) + newString + content.substring(index + search.length);
    }
  }

  if (!found) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
    );
  }
  throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.");
}

// trimDiff() lives in ./shared/diff.js (imported above).

export async function edit(params = {}, context = {}) {
  void context;
  try {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return fail("Parameters must be an object with 'filePath', 'oldString' and 'newString'.");
    }
    const { filePath, oldString, newString, replaceAll = false } = params;
    if (typeof filePath !== "string" || filePath.trim() === "") {
      return fail("Parameter 'filePath' must be a non-empty string.");
    }
    if (typeof oldString !== "string") {
      return fail("Parameter 'oldString' must be a string (use an empty string only to create a new file).");
    }
    if (typeof newString !== "string") {
      return fail("Parameter 'newString' must be a string.");
    }
    if (replaceAll !== undefined && typeof replaceAll !== "boolean") {
      return fail("Parameter 'replaceAll' must be a boolean when provided.");
    }
    if (oldString === newString) {
      return fail("No changes to apply: oldString and newString are identical.");
    }

    let resolved;
    try {
      resolved = resolveWorkspacePath(filePath);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    return await withFileLock(resolved, async () => {
      // Create-new-file path: an empty oldString on an existing file is a
      // mistake (use write for full replacement), not a valid edit.
      if (oldString === "") {
        if (fs.statSync(resolved, { throwIfNoEntry: false })) {
          return fail(
            "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
          );
        }
        const next = splitBom(newString);
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, joinBom(next.text, next.bom), "utf8");
        const diff = trimDiff(createTwoFilesPatch(resolved, resolved, "", next.text));
        return {
          success: true,
          output: "Edit applied successfully.",
          diff,
          additions: next.text.split("\n").length,
          deletions: 0,
        };
      }

      const info = fs.statSync(resolved, { throwIfNoEntry: false });
      if (!info) {
        return fail(`File not found: ${filePath}`);
      }
      if (!info.isFile()) {
        return fail(`Path is a directory, not a file: ${filePath}`);
      }

      let raw;
      try {
        raw = await readFile(resolved, "utf8");
      } catch (error) {
        return fail(`Cannot read file: ${error instanceof Error ? error.message : String(error)}`);
      }
      const source = splitBom(raw);
      const ending = detectLineEnding(source.text);
      const old = convertToLineEnding(normalizeLineEndings(oldString), ending);
      const replacement = convertToLineEnding(normalizeLineEndings(newString), ending);

      let contentNew;
      try {
        const replaced = replace(source.text, old, replacement, replaceAll === true);
        const next = splitBom(replaced);
        contentNew = next.text;
        await writeFile(resolved, joinBom(contentNew, next.bom || source.bom), "utf8");
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }

      const diff = trimDiff(
        createTwoFilesPatch(resolved, resolved, normalizeLineEndings(source.text), normalizeLineEndings(contentNew)),
      );
      let additions = 0;
      let deletions = 0;
      for (const change of diffLines(source.text, contentNew)) {
        if (change.added) additions += change.count ?? 0;
        if (change.removed) deletions += change.count ?? 0;
      }
      return {
        success: true,
        output: "Edit applied successfully.",
        diff,
        additions,
        deletions,
      };
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
