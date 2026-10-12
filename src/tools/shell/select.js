// src/tools/shell/select.js
// Shell selection, ported from opencode packages/core/src/shell.ts (read-only reference).
// Plain JS, no Effect. Resolves an acceptable shell executable for this platform.

import path from "node:path";
import fs from "node:fs";
import { readFile } from "node:fs/promises";

const META = {
  bash: { login: true, posix: true },
  dash: { login: true, posix: true },
  fish: { deny: true, login: true },
  ksh: { login: true, posix: true },
  nu: { deny: true },
  powershell: { ps: true },
  pwsh: { ps: true },
  sh: { login: true, posix: true },
  zsh: { login: true, posix: true },
};

function stat(file) {
  try {
    return fs.statSync(file, { throwIfNoEntry: false }) ?? undefined;
  } catch {
    return undefined;
  }
}

function windowsPath(file) {
  if (typeof file !== "string") return file;
  return file.replace(/\//g, "\\");
}

function whichShell(name) {
  if (!name) return undefined;
  const resolved = path.isAbsolute(name) ? name : null;
  if (resolved) {
    return stat(resolved)?.isFile() ? resolved : undefined;
  }
  const envPath = process.env.PATH ?? "";
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + (process.platform === "win32" ? ext.toLowerCase() : ext));
      // Also try exact name (already has extension).
      for (const file of [candidate, path.join(dir, name)]) {
        try {
          const st = stat(file);
          if (st?.isFile()) return file;
        } catch {
          // continue
        }
      }
    }
  }
  return undefined;
}

function full(file) {
  if (process.platform !== "win32") return file;
  const shell = windowsPath(file);
  if (path.win32.dirname(shell) !== ".") {
    if (shell.startsWith("/") && name(shell) === "bash") return gitbash() || shell;
    return shell;
  }
  if (name(shell) === "bash") return gitbash() || whichShell(shell) || shell;
  return whichShell(shell) || shell;
}

function meta(file) {
  return META[name(file)];
}

function ok(file) {
  return meta(file)?.deny !== true;
}

function rooted(file) {
  return path.isAbsolute(windowsPath(file));
}

function resolveShell(file) {
  const shell = full(file);
  if (rooted(shell)) {
    if (stat(shell)?.isFile()) return shell;
    return undefined;
  }
  return whichShell(shell) ?? undefined;
}

function winCandidates() {
  const list = [
    whichShell("pwsh"),
    whichShell("powershell"),
    gitbash(),
    process.env.COMSPEC || "cmd.exe",
  ].filter(Boolean);
  return [...new Set(list.map(full))];
}

async function unixCandidates() {
  try {
    const text = await readFile("/etc/shells", "utf8");
    if (text) {
      return [...new Set(text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")))];
    }
  } catch {
    // ignore, fallback below
  }
  return ["/bin/bash", "/bin/zsh", "/bin/sh"];
}

function select(file, opts) {
  if (file && (!opts?.acceptable || ok(file))) {
    const shell = resolveShell(file);
    if (shell) return shell;
  }
  if (process.platform === "win32") return winCandidates()[0];
  return fallback();
}

export function gitbash() {
  if (process.platform !== "win32") return undefined;
  if (process.env.OPENCODE_GIT_BASH_PATH) return process.env.OPENCODE_GIT_BASH_PATH;
  const git = whichShell("git");
  if (!git) return undefined;
  const file = path.join(git, "..", "..", "bin", "bash.exe");
  if (stat(file)?.size) return file;
  return undefined;
}

function fallback() {
  if (process.platform === "darwin") return "/bin/zsh";
  const bash = whichShell("bash");
  if (bash) return bash;
  return "/bin/sh";
}

export function name(file) {
  if (!file) return "";
  if (process.platform === "win32") return path.win32.parse(windowsPath(file)).name.toLowerCase();
  return path.basename(file).toLowerCase();
}

export function isLogin(file) {
  return meta(file)?.login === true;
}

export function isPosix(file) {
  return meta(file)?.posix === true;
}

export function isPS(file) {
  return meta(file)?.ps === true;
}

let defaultPreferred;
let defaultAcceptable;

export function preferred(configShell) {
  if (configShell) return select(configShell);
  defaultPreferred ??= select(process.env.SHELL);
  return defaultPreferred;
}

export function acceptable(configShell) {
  if (configShell) return select(configShell, { acceptable: true });
  defaultAcceptable ??= select(process.env.SHELL, { acceptable: true });
  return defaultAcceptable;
}

export function resetCache() {
  defaultPreferred = undefined;
  defaultAcceptable = undefined;
}

export async function list() {
  const shells = process.platform === "win32" ? winCandidates() : await unixCandidates();
  return shells
    .filter((s) => resolveShell(s))
    .map((s) => {
      const item = full(s);
      const n = name(item);
      return { path: item, name: resolveShell(n) ? n : item, acceptable: ok(item) };
    });
}
