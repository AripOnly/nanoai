// src/tools/shell/parse.js
// Command analysis with blocklists and structured scan sets
// (CWD/FILES sets, expand/provider/dynamic/prefix/pathArgs) + nano HARD_BLOCKS.
// Plain JS tokenizer (no tree-sitter WASM yet), splits chains then tokens.

import path from "node:path";
import os from "node:os";

export const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"]);
export const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
]);
export const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
]);
export const FLAGS = new Set(["-destination", "-literalpath", "-path"]);
export const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"]);

const HARD_BLOCKS = [
  [/\bformat\b\s+[a-z]:/, "disk formatting is never allowed"],
  [/(^|[|;&\s])diskpart(\.exe)?\b/, "disk partitioning is never allowed"],
  [/(^|[|;&\s])bcdedit(\.exe)?\b/, "boot configuration edits are never allowed"],
  [/\bvssadmin(\.exe)?\s+delete\s+shadows\b/, "deleting volume shadow copies is never allowed"],
  [/\bcipher(\.exe)?\s+\/w/, "secure drive wiping is never allowed"],
  [/(^|[|;&\s])(rm|del|erase|rd|rmdir|remove-item)\b[^|;&]*[a-z]:\\(\s|["']|$)/, "deleting a drive root is never allowed"],
  [/(^|[|;&\s])(rm|del|erase|rd|rmdir|remove-item)\b[^|;&]*[a-z]:\\windows\b/, "deleting inside the Windows directory is never allowed"],
  [/(^|[|;&\s])rm\b\s+-[a-z]*r[a-z]*\s+[^\s|;&]*(\/\*?|~)(\s|$)/, "recursive deletion of filesystem root or home is never allowed"],
  [/(^|[|;&\s])mkfs\b/, "filesystem creation is never allowed"],
  [/\bdd\b[^|;&]*of=\/dev\//, "raw disk writes are never allowed"],
  [/:?\(\)\s*\{[^}]*\}\s*;?/, "fork bombs are never allowed"],
  [/(^|[|;&\s])(shutdown(\.exe)?\s+\/[srh]|stop-computer|restart-computer|reboot|halt|poweroff|init\s+[06])\b/, "powering off or rebooting the machine is never allowed"],
  [/\breg(\.exe)?\s+delete\b/, "registry deletion is never allowed"],
  [/\bnet(\.exe)?\s+user\b[^|;&]*\/delete/, "deleting OS user accounts is never allowed"],
  [/\b(iwr|invoke-webrequest|curl|wget)\b[^|;&]*\|\s*(powershell(\.exe)?|iex|invoke-expression|bash|sh)\b/, "piping downloads straight into a shell is never allowed; download the file, inspect it, then run it"],
  [/(^|[\s;])(powershell(\.exe)?\s+)?-e(nc(odedcommand)?)?\b/, "obfuscated (-EncodedCommand) invocations are never allowed; resubmit the command in plain text"],
];

export function findBlock(command) {
  const lower = String(command).toLowerCase();
  if (/shutdown(\.exe)?\s+\/a\b/.test(lower)) return null;
  for (const [pattern, reason] of HARD_BLOCKS) {
    if (pattern.test(lower)) return reason;
  }
  return null;
}

export function unquote(text) {
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1);
  return text;
}

function home(text) {
  if (text === "~") return os.homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function envValue(key) {
  if (process.platform !== "win32") return process.env[key];
  const found = Object.keys(process.env).find((k) => k.toLowerCase() === key.toLowerCase());
  return found ? process.env[found] : undefined;
}

function auto(key, cwd, shell) {
  const n = key.toUpperCase();
  if (n === "HOME") return os.homedir();
  if (n === "PWD") return cwd;
  if (n === "PSHOME") return path.dirname(shell);
  return undefined;
}

export function expand(text, cwd, shell) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key) => auto(key, cwd, shell) || "");
  return home(out);
}

function provider(text) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/);
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return undefined;
    return match[2];
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/);
  if (!prefix) return text;
  if (prefix[1].length === 1) return text;
  return undefined;
}

export function isDynamic(text, ps) {
  if (text.startsWith("(") || text.startsWith("@(")) return true;
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true;
  if (ps) return /\$(?!env:)/i.test(text);
  return text.includes("$");
}

function globPrefix(text) {
  const match = /[?*[]/.exec(text);
  if (!match) return text;
  if (match.index === 0) return undefined;
  return text.slice(0, match.index);
}

function normalizeWindows(p) {
  return p.replace(/\//g, "\\");
}

export function resolvePath(text, root, shell, posixShell) {
  if (process.platform === "win32") {
    // POSIX-style absolute on win (git-bash) -> keep as-is, resolve handles it.
    return path.resolve(root, normalizeWindows(text));
  }
  return path.resolve(root, text);
}

export function argPath(arg, cwd, ps, shell) {
  const text = ps ? expand(arg, cwd, shell) : home(unquote(arg));
  const file = text && globPrefix(text);
  if (!file || isDynamic(file, ps)) return undefined;
  const next = ps ? provider(file) : file;
  if (!next) return undefined;
  return resolvePath(next, cwd, shell);
}

function splitChains(command) {
  // Split on shell chain operators while respecting quotes.
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if ((c === "&" && command[i + 1] === "&") || (c === "|" && command[i + 1] === "|")) {
      out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

function tokenize(cmd) {
  return cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function pathArgs(tokens, ps, isCmd) {
  if (!ps) {
    return tokens
      .slice(1)
      .filter(
        (t) =>
          !t.startsWith("-") &&
          !(isCmd && t.startsWith("/")) &&
          !(tokens[0] === "chmod" && t.startsWith("+")),
      );
  }
  const out = [];
  let want = false;
  for (const item of tokens.slice(1)) {
    if (want) {
      out.push(item);
      want = false;
      continue;
    }
    if (item.startsWith("-")) {
      const flag = item.toLowerCase();
      if (SWITCHES.has(flag)) continue;
      want = FLAGS.has(flag);
      continue;
    }
    out.push(item);
  }
  return out;
}

function shellKind(shellPath) {
  const base = path.basename(String(shellPath)).toLowerCase().replace(/\.exe$/, "");
  if (base === "pwsh" || base === "powershell") return base;
  if (base === "cmd") return "cmd";
  return "bash";
}

/**
 * Analyze a shell command before execution.
 * Keeps old analyze.js return shape for safety.test.js compat,
 * plus a structured scan { dirs, patterns, always, paths }.
 */
export function analyzeCommand(command, cwd = process.cwd(), shell = "") {
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("Command must be a non-empty string.");
  }
  const kind = shellKind(shell || (process.platform === "win32" ? "powershell" : "bash"));
  const ps = kind === "pwsh" || kind === "powershell";
  const isCmd = kind === "cmd";

  const chains = splitChains(command);
  const dirs = new Set();
  const patterns = new Set();
  const always = new Set();
  const paths = [];
  let firstName = "";
  let firstFileCommand = false;
  let firstCwdCommand = false;

  for (const part of chains) {
    const rawTokens = tokenize(part);
    if (rawTokens.length === 0) continue;
    const cmdName = ps || isCmd ? unquote(rawTokens[0]).toLowerCase() : unquote(rawTokens[0]);
    if (!firstName) {
      firstName = cmdName;
      firstFileCommand = FILES.has(cmdName) || (isCmd && CMD_FILES.has(cmdName));
      firstCwdCommand = CWD.has(cmdName);
    }

    if (cmdName && (FILES.has(cmdName) || (isCmd && CMD_FILES.has(cmdName)))) {
      for (const arg of pathArgs(rawTokens, ps, isCmd)) {
        const resolved = argPath(arg, cwd, ps, shell);
        if (!resolved) continue;
        paths.push(resolved);
        dirs.add(path.dirname(resolved));
      }
    }

    if (rawTokens.length && (!cmdName || !CWD.has(cmdName))) {
      patterns.add(part.trim());
      const arity = rawTokens.slice(0, 2).join(" ");
      always.add(arity + " *");
    }
  }

  return {
    command,
    name: firstName,
    cwd,
    fileCommand: firstFileCommand,
    cwdCommand: firstCwdCommand,
    paths,
    scan: { dirs, patterns, always },
    blocked: findBlock(command),
  };
}
