// src/tools/rg.js
//
// Shared ripgrep runner (external `rg` binary + pinned download fallback).
//
// ripgrep ("rg") is an external search executable, not a JS library. Both the
// glob tool (file names) and the grep tool (file contents) spawn it as a
// child process with deterministic flags (--no-config) and parse stdout.
//
// Binary resolution order:
//   1. System `rg` on PATH.
//   2. Cached download under the per-user data dir (~/.nanoai/bin).
//   3. Download pinned release v15.1.0 from GitHub.
// The download URL is a hardcoded constant; no user input ever reaches it.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dataDir } from "#src/shared/data-dir.js";
import { killProcessTree } from "#src/infra/platform.js";

const RG_VERSION = "15.1.0";

// Maps Node's arch-platform pairs to ripgrep release asset names.
const PLATFORM_ASSETS = {
  "arm64-darwin": { asset: "aarch64-apple-darwin", extension: "tar.gz" },
  "arm64-linux": { asset: "aarch64-unknown-linux-gnu", extension: "tar.gz" },
  "x64-darwin": { asset: "x86_64-apple-darwin", extension: "tar.gz" },
  "x64-linux": { asset: "x86_64-unknown-linux-musl", extension: "tar.gz" },
  "arm64-win32": { asset: "aarch64-pc-windows-msvc", extension: "zip" },
  "ia32-win32": { asset: "i686-pc-windows-msvc", extension: "zip" },
  "x64-win32": { asset: "x86_64-pc-windows-msvc", extension: "zip" },
};

const ERROR_BYTES = 8 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_LINE_CHARS = 2_000;
// Hard ceiling so a hung ripgrep can never leak a child process forever on a
// 24/7 agent, in addition to caller abort.
const INTERNAL_TIMEOUT_MS = 60_000;

// Per-user binary cache (three levels up was the old repo-relative layout;
// the data dir survives global installs and restarts alike).
const BIN_DIR = path.join(dataDir(), "bin");
const CACHED_BINARY = path.join(BIN_DIR, process.platform === "win32" ? "rg.exe" : "rg");

// Coalesces concurrent resolutions so two tools never download twice.
let binaryPromise = null;

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Parameter '${name}' must be a non-empty string.`);
  }
}

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Parameter '${name}' must be a positive integer.`);
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function whichBinary(name) {
  // Absolute path: accept only if it is an executable file.
  if (path.isAbsolute(name)) {
    return isFile(name) ? name : undefined;
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())
      : [""];
  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? [path.join(dir, name), ...extensions.map((ext) => path.join(dir, name + ext))]
        : [path.join(dir, name)];
    for (const candidate of candidates) {
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

async function extractArchive(archive, extension, destDir) {
  await mkdir(destDir, { recursive: true });
  if (extension === "zip") {
    // Windows has no system tar for zip; PowerShell is always present.
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${destDir.replaceAll("'", "''")}' -Force`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (code !== 0) {
      throw new Error(`Failed to extract ripgrep archive (exit code ${code}).`);
    }
    return;
  }
  const child = spawn("tar", ["-xzf", archive, "-C", destDir], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`Failed to extract ripgrep archive (exit code ${code}).`);
  }
}

async function downloadBinary() {
  const key = `${process.arch}-${process.platform}`;
  const config = PLATFORM_ASSETS[key];
  if (!config) {
    throw new Error(`Unsupported platform for ripgrep: ${key}. Install ripgrep manually and put it on PATH.`);
  }
  const filename = `ripgrep-${RG_VERSION}-${config.asset}.${config.extension}`;
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${filename}`;

  await mkdir(BIN_DIR, { recursive: true });
  const archive = path.join(BIN_DIR, filename);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ripgrep (HTTP ${response.status}). Install ripgrep manually and put it on PATH.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("Downloaded ripgrep archive is empty. Install ripgrep manually and put it on PATH.");
  }
  await writeFile(archive, bytes);

  try {
    const extractDir = path.join(BIN_DIR, `ripgrep-${Date.now()}`);
    await extractArchive(archive, config.extension, extractDir);
    const extracted = path.join(
      extractDir,
      `ripgrep-${RG_VERSION}-${config.asset}`,
      process.platform === "win32" ? "rg.exe" : "rg",
    );
    if (!isFile(extracted)) {
      throw new Error("Downloaded ripgrep archive did not contain the expected executable.");
    }
    await copyFile(extracted, CACHED_BINARY);
    if (process.platform !== "win32") {
      fs.chmodSync(CACHED_BINARY, 0o755);
    }
    await rm(extractDir, { recursive: true, force: true });
  } finally {
    await rm(archive, { force: true });
  }
  return CACHED_BINARY;
}

/**
 * Resolve the ripgrep executable path, downloading it on first use when no
 * system binary exists. The result is process-cached.
 */
export async function resolveRgBinary() {
  if (!binaryPromise) {
    binaryPromise = (async () => {
      const system = whichBinary(process.platform === "win32" ? "rg.exe" : "rg");
      if (system) return system;
      if (isFile(CACHED_BINARY)) return CACHED_BINARY;
      return downloadBinary();
    })().catch((error) => {
      // Allow a later call to retry instead of caching the failure forever.
      binaryPromise = null;
      throw error;
    });
  }
  return binaryPromise;
}

async function killTree(child) {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  await killProcessTree(pid, { graceMs: 200 });
}

function isInvalidPatternMessage(stderr) {
  return stderr.includes("regex parse error") || stderr.includes("error parsing regex");
}

/**
 * Spawn ripgrep and collect stdout lines up to limit + 1 (the extra line only
 * detects truncation; it is never returned). Rejects on spawn failure.
 */
export function runRg({ binary, args, cwd, limit, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const lines = [];
    let truncated = false;
    let buffer = "";
    let stderr = "";
    let finished = false;

    // Single owner of the settle flag: every exit path goes through finish()
    // or rejectOnce() exactly once. Never set `finished` directly in the
    // handlers below, or the promise will never settle.
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const rejectOnce = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (line.length === 0) continue;
        if (lines.length > limit) {
          truncated = true;
          continue;
        }
        lines.push(line);
      }
    });

    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr, "utf8") < ERROR_BYTES) {
        stderr += chunk.toString("utf8");
      }
    });

    child.on("error", (error) => {
      try {
        signal?.removeEventListener("abort", abortHandler);
      } catch {
        // Listener already gone; nothing to do.
      }
      rejectOnce(error);
    });

    const abortHandler = () => {
      // Killing is enough; the child's close event settles the promise.
      killTree(child).catch(() => {});
    };
    if (signal) {
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }

    const timer = setTimeout(() => {
      killTree(child).catch(() => {});
      // Resolve as a failure instead of hanging: the caller reports it.
      finish({ lines: [], truncated: false, code: null, stderr: "", timedOut: true });
    }, INTERNAL_TIMEOUT_MS);

    child.on("close", (code) => {
      try {
        signal?.removeEventListener("abort", abortHandler);
      } catch {
        // Listener already gone; nothing to do.
      }
      if (buffer.length > 0 && lines.length <= limit) {
        lines.push(buffer);
      } else if (buffer.length > 0) {
        truncated = true;
      }
      finish({ lines: lines.slice(0, limit), truncated, code, stderr, timedOut: false });
    });
  });
}

function normalizeRelative(line) {
  return line
    .replace(/^(?:\.[\\/])+/u, "")
    .replace(/^[\\/]+/u, "")
    .replaceAll("\\", "/");
}

/**
 * List files matching a glob pattern (rg --files --glob).
 * Returns { files: string[] } with forward-slash relative paths.
 */
export async function rgGlob({ cwd, pattern, limit = 100, signal }) {
  assertNonEmptyString(cwd, "cwd");
  assertNonEmptyString(pattern, "pattern");
  assertPositiveInt(limit, "limit");
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Search directory does not exist: ${cwd}`);
  }

  const binary = await resolveRgBinary();
  const result = await runRg({
    binary,
    cwd,
    limit,
    signal,
    args: ["--no-config", "--files", `--glob=${pattern}`, "--glob=!**/.git/**", "."],
  });
  if (result.timedOut) {
    throw new Error("File search timed out. Use a more specific path or pattern.");
  }
  if (result.code !== 0 && result.code !== 1) {
    const detail = result.stderr.trim();
    throw new Error(detail ? `File search failed: ${detail}` : `File search failed with exit code ${result.code}.`);
  }
  return { files: result.lines.map(normalizeRelative), truncated: result.truncated };
}

/**
 * Search file contents with a regex (rg --json).
 * Returns { matches: Array<{ path, line, text }> } with relative paths.
 * An invalid regex resolves to a failure result (not a throw) so callers can
 * surface "pattern is invalid" distinctly from execution errors.
 */
export async function rgGrep({ cwd, pattern, include, file, limit = 100, signal }) {
  assertNonEmptyString(cwd, "cwd");
  assertNonEmptyString(pattern, "pattern");
  assertPositiveInt(limit, "limit");
  if (include !== undefined) assertNonEmptyString(include, "include");
  if (file !== undefined) assertNonEmptyString(file, "file");
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Search directory does not exist: ${cwd}`);
  }

  const binary = await resolveRgBinary();
  const result = await runRg({
    binary,
    cwd,
    limit,
    signal,
    args: [
      "--no-config",
      "--json",
      "--hidden",
      "--no-messages",
      ...(include ? [`--glob=${include}`] : []),
      "--glob=!**/.git/**",
      "--",
      pattern,
      file ?? ".",
    ],
  });
  if (result.timedOut) {
    throw new Error("Content search timed out. Use a more specific path or pattern.");
  }
  if (result.code === 2 && isInvalidPatternMessage(result.stderr)) {
    return { matches: [], truncated: false, invalidPattern: result.stderr.trim() };
  }
  if (result.code !== 0 && result.code !== 1 && result.code !== 2) {
    const detail = result.stderr.trim();
    throw new Error(detail ? `Content search failed: ${detail}` : `Content search failed with exit code ${result.code}.`);
  }
  // Exit code 1 means "no matches", which is a normal empty result.
  // Exit code 2 with other stderr is partial output; still parse what arrived.
  const matches = [];
  for (const line of result.lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) continue;
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    if (!json || typeof json !== "object" || json.type !== "match" || !json.data) continue;
    const data = json.data;
    if (typeof data?.path?.text !== "string") continue;
    if (typeof data?.line_number !== "number" || typeof data?.lines?.text !== "string") continue;
    let text = data.lines.text;
    if (text.length > MAX_LINE_CHARS) {
      // Avoid splitting a UTF-16 surrogate pair at the cut point.
      text = text.slice(0, MAX_LINE_CHARS).replace(/[\uD800-\uDBFF]$/, "") + "...";
    }
    matches.push({
      path: normalizeRelative(data.path.text),
      line: data.line_number,
      text: text.replace(/\r?\n$/, ""),
    });
  }
  return { matches, truncated: result.truncated, invalidPattern: null };
}

