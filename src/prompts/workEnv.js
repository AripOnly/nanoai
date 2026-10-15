import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { resolveHomeDir, resolveWorkspaceRoot } from "#src/tools/shared/workspace.js";

const platform = process.platform;

// Human-friendly OS names: raw process.platform values ("win32") are jargon.
function displayOS() {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  return "Linux";
}

function defaultShell() {
  if (platform === "win32") return "PowerShell";
  // macOS ships zsh as the default login shell.
  if (platform === "darwin") return "zsh";
  return "bash";
}

const shell = defaultShell();

export function getWorkEnv() {
  const home = os.homedir();
  let location = home;
  try {
    const h = resolveHomeDir();
    if (h && h.trim() !== "") location = h;
  } catch {
    location = home;
  }
  let saveDir = location;
  try {
    saveDir = resolveWorkspaceRoot();
  } catch {
    saveDir = path.join(home, "nano-workspace");
  }
  const desktop = path.join(home, "Desktop");
  let desktopLine = "";
  try {
    if (fs.statSync(desktop).isDirectory()) {
      desktopLine = `\n- The user's other projects usually live in ${desktop} (reachable via ABSOLUTE paths).`;
    }
  } catch {
    // Desktop absent (e.g. server layouts): omit instead of misleading.
  }
  return `
# You are running on:

- Operating System: ${displayOS()} (${platform})
- Shell: ${shell}
- Your Current Location: ${location}
- Home directory: ${home}${desktopLine}
- Default save location: ${saveDir} (use this when the user asks to create a file or folder without mentioning a path)
- You can work in other directories when needed by using the \`workdir\` parameter.

# Path strategy (follow strictly):

- Prefer ABSOLUTE paths in every tool call. Relative paths resolve against the default save location above (nano-workspace), never against the launch directory.
- When the user does NOT mention a path, save to the default save location above (e.g. "catatan.txt" -> default-save/catatan.txt, "docs/a.txt" -> default-save/docs/a.txt).
- When the user DOES mention a path, follow it exactly with an absolute path (read, write, edit, search, and shell all honor explicit absolute paths, e.g. Desktop).
- Search results always state WHERE they searched. If a search or read finds nothing, do not blindly retry other patterns:
  first check the searched directory, then retry once with the absolute location (e.g. under the home/Desktop folders above).
- Never invent a relative prefix for a project you cannot see (like "nanoai/**/..." out of thin air).
  If you cannot locate the folder after one absolute-path attempt, ask the user where it is.
`;
}
