// src/tools/shell/prompt.js
// Shell tool description + JSON schema.
// Tool name stays "shell" for nanoai compat.

import os from "node:os";

const PS = new Set(["powershell", "pwsh"]);
const CMD = new Set(["cmd"]);

const DESCRIPTION_TEMPLATE = `\${intro}

Be aware: OS: \${os}, Shell: \${shell}

\${workdirSection}

Use \`\${tmp}\` for temporary work outside the workspace. This directory has already been created, already exists, and is pre-approved for external directory access.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

\${commandSection}

# Background jobs
- Set \`background: true\` for long-running work (builds, test suites, servers, downloads). The command keeps running if the gateway restarts and the session can continue when it finishes.
- Poll or control it with the \`process\` tool (\`poll\`, \`log\`, \`list\`, \`kill\`, \`remove\`). Do not busy-wait or call sleep in the same turn.
- \`notify: "failure"\` wakes the session only for a non-zero exit; \`"never"\` leaves completion to polling.
- Logs are bounded and tailed into the prompt. Read specific ranges with \`process.log\` instead of dumping the whole log.

# Git and GitHub
- Only commit, amend, push, or create PRs when explicitly requested.
- Before committing, inspect \`git status\`, \`git diff\`, and \`git log --oneline -10\`; stage only intended files and never commit secrets.
- Write a concise commit message that matches the repo style.
- Do not update git config, skip hooks, use interactive \`-i\`, force-push, or create empty commits unless explicitly requested.
- If a commit fails or hooks reject it, fix the issue and create a new commit; do not amend the failed commit.
- Before creating a PR, inspect status, diff, remote tracking, recent commits, and the diff from the base branch.
- Review all commits included in the PR, not just the latest commit.
- Use \`gh\` for GitHub tasks, including PRs, issues, checks, and releases; return the PR URL when done.`;

export function parameterSchema() {
  return {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to execute",
      },
      timeout: {
        type: "number",
        description: "Optional timeout in milliseconds",
      },
      workdir: {
        type: "string",
        description:
          "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.",
      },
      background: {
        type: "boolean",
        description:
          "Run detached and return a job id immediately. Use for long builds, servers, downloads, or tests. Poll with the process tool; never wait with sleep.",
      },
      name: {
        type: "string",
        description:
          "Short label for a background job (optional). Ignored for foreground commands.",
      },
      notify: {
        type: "string",
        enum: ["always", "failure", "never"],
        description:
          "When a background job should wake the session. Defaults to the configured jobs.notifyDefault policy (usually always); ignored for foreground commands.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  };
}

function renderPrompt(template, values) {
  return template.replace(/\$\{(\w+)\}/g, (_, key) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Missing shell prompt value: ${key}`);
    return value;
  });
}

function shellDisplayName(n) {
  if (n === "pwsh") return "PowerShell (7+)";
  if (n === "powershell") return "Windows PowerShell (5.1)";
  if (n === "cmd") return "cmd.exe";
  return n;
}

function powershellNotes(n) {
  if (n === "pwsh") {
    return `# PowerShell (7+) shell notes
- This cross-platform shell supports pipeline chain operators (\`&&\` and \`||\`).
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Prefer full cmdlet names like \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`, and \`New-Item\` over aliases.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- To call a native executable whose path contains spaces, use the call operator: \`& "path/to/exe" args\`.
- Escape special characters with the PowerShell backtick character.`;
  }
  if (n === "powershell") {
    return `# Windows PowerShell (5.1) shell notes
- Use \`cmd1; if ($?) { cmd2 }\` to chain dependent commands.
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Prefer full cmdlet names like \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`, and \`New-Item\` over aliases.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- To call a native executable whose path contains spaces, use the call operator: \`& "path/to/exe" args\`.
- Escape special characters with the PowerShell backtick character.`;
  }
  return "";
}

function chainGuidance(n) {
  if (n === "powershell") {
    return "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell (5.1) does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success.";
  }
  if (PS.has(n)) {
    return "If the commands depend on each other and must run sequentially, use a single bash tool call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like New-Item before Copy-Item, Write before bash for git operations, or git add before git commit), run these operations sequentially instead.";
  }
  if (CMD.has(n)) {
    return "If the commands depend on each other and must run sequentially, use a single bash tool call with `&&` to chain them together (e.g., `mkdir out && dir out`). For instance, if one operation must complete before another starts, run these operations sequentially instead.";
  }
  return "If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead.";
}

function bashCommandSection(chain, limits, defaultTimeoutMs) {
  return `Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use \`ls\` to verify the parent directory exists and is the correct location
   - For example, before running "mkdir foo/bar", first use \`ls foo\` to check that "foo" exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., rm "path with spaces/file.txt")
   - Examples of proper quoting:
     - mkdir "/Users/name/My Documents" (correct)
     - mkdir /Users/name/My Documents (incorrect - will fail)
     - python "/path/with spaces/script.py" (correct)
     - python /path/with spaces/script.py (incorrect - will fail)
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after ${defaultTimeoutMs}ms.
  - If the output exceeds ${limits.maxLines} lines or ${limits.maxBytes} bytes, it will be truncated and the full output will be written to a file. You can use Read with offset/limit to read specific sections or Grep to search the full content. Do NOT use \`head\`, \`tail\`, or other truncation commands to limit output; the full output will already be captured to a file for more precise searching.

  - Avoid using Bash with the \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:
    - File search: Use Glob (NOT find or ls)
    - Content search: Use Grep (NOT grep or rg)
    - Read files: Use Read (NOT cat/head/tail)
    - Edit files: Use Edit (NOT sed/awk)
    - Write files: Use Write (NOT echo >/cat <<EOF)
    - Communication: Output text directly (NOT echo/printf)
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple bash tool calls in a single message. For example, if you need to run "git status" and "git diff", send a single message with two bash tool calls in parallel.
    - ${chain}
    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail
    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)
  - AVOID using \`cd <directory> && <command>\`. Use the \`workdir\` parameter to change directories instead.
    <good-example>
    Use workdir="/foo/bar" with command: pytest tests
    </good-example>
    <bad-example>
    cd /foo/bar && pytest tests
    </bad-example>`;
}

function powershellCommandSection(n, chain, pathSep, limits, defaultTimeoutMs) {
  return `${powershellNotes(n)}

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use \`Test-Path -LiteralPath <parent>\` to verify the parent directory exists and is the correct location
   - For example, before creating \`foo${pathSep}bar\`, first use \`Test-Path -LiteralPath "foo"\` to check that \`foo\` exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., Remove-Item -LiteralPath "path with spaces${pathSep}file.txt")
   - Examples of proper quoting:
     - New-Item -ItemType Directory -Path "My Documents" (correct)
     - New-Item -ItemType Directory -Path My Documents (incorrect - path is split)
     - & "path with spaces${pathSep}script.ps1" (correct)
     - path with spaces${pathSep}script.ps1 (incorrect - path is split and not invoked)
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after ${defaultTimeoutMs}ms.
  - If the output exceeds ${limits.maxLines} lines or ${limits.maxBytes} bytes, it will be truncated and the full output will be written to a file. You can use Read with offset/limit to read specific sections or Grep to search the full content. Do NOT use \`Select-Object -First\`, \`Select-Object -Last\`, or other truncation commands to limit output; the full output will already be captured to a file for more precise searching.

  - Avoid using Shell with PowerShell file/content cmdlets unless explicitly instructed or when these cmdlets are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:
    - File search: Use Glob (NOT Get-ChildItem)
    - Content search: Use Grep (NOT Select-String)
    - Read files: Use Read (NOT Get-Content)
    - Edit files: Use Edit (NOT Set-Content)
    - Write files: Use Write (NOT Set-Content/Out-File or here-strings)
    - Communication: Output text directly (NOT Write-Output/Write-Host)
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple bash tool calls in a single message. For example, if you need to run "git status" and "git diff", send a single message with two bash tool calls in parallel.
    - ${chain}
    - Use \`;\` only when you need to run commands sequentially but don't care if earlier commands fail
    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)
  - AVOID changing directories inside the command. Use the \`workdir\` parameter to change directories instead.
    <good-example>
    Use workdir="project${pathSep}subdir" with command: pytest tests
    </good-example>
    <bad-example>
    ${n === "powershell" ? `Set-Location -LiteralPath "project${pathSep}subdir"; if ($?) { pytest tests }` : `Set-Location -LiteralPath "project${pathSep}subdir" && pytest tests`}
    </bad-example>`;
}

function cmdCommandSection(chain, limits, defaultTimeoutMs) {
  return `# cmd.exe shell notes
- Use double quotes for paths with spaces.
- Use %VAR% for environment variables.
- Use \`if exist\` for existence checks.
- Use \`call\` when invoking batch files from another batch-style command.

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use \`if exist\` to verify the parent directory exists and is the correct location
   - For example, before creating \`foo\\bar\`, first use \`if exist "foo\\" dir "foo"\` to check that \`foo\` exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., del "path with spaces\\file.txt")
   - Examples of proper quoting:
     - mkdir "My Documents" (correct)
     - mkdir My Documents (incorrect - path is split)
     - call "path with spaces\\script.bat" (correct)
     - path with spaces\\script.bat (incorrect - path is split and not invoked correctly)
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after ${defaultTimeoutMs}ms.
  - If the output exceeds ${limits.maxLines} lines or ${limits.maxBytes} bytes, it will be truncated and the full output will be written to a file. You can use Read with offset/limit to read specific sections or Grep to search the full content. Do NOT use \`more\` or other pagination commands to limit output; the full output will already be captured to a file for more precise searching.

  - Avoid using Shell with cmd.exe file/content commands unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:
    - File search: Use Glob (NOT dir /s)
    - Content search: Use Grep (NOT findstr)
    - Read files: Use Read (NOT type)
    - Edit files: Use Edit (NOT copy)
    - Write files: Use Write (NOT echo > file)
    - Communication: Output text directly (NOT echo)
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple bash tool calls in a single message. For example, if you need to run "dir" and "where cmd", send a single message with two bash tool calls in parallel.
    - ${chain}
    - Use \`&\` only when you need to run commands sequentially but don't care if earlier commands fail
    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)
  - AVOID changing directories inside the command. Use the \`workdir\` parameter to change directories instead.
    <good-example>
    Use workdir="project\\\\subdir" with command: dir
    </good-example>
    <bad-example>
    cd /d "project\\\\subdir" && dir
    </bad-example>`;
}

function profile(shellName, platform, limits, defaultTimeoutMs) {
  const isPowerShell = PS.has(shellName);
  const chain = chainGuidance(shellName);
  if (CMD.has(shellName)) {
    return {
      intro: `Executes a given ${shellDisplayName(shellName)} command with optional timeout, ensuring proper handling and security measures.`,
      workdirSection:
        "All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID changing directories inside the command - use `workdir` instead.",
      commandSection: cmdCommandSection(chain, limits, defaultTimeoutMs),
    };
  }
  if (isPowerShell) {
    return {
      intro: `Executes a given ${shellDisplayName(shellName)} command with optional timeout, ensuring proper handling and security measures.`,
      workdirSection:
        "All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID changing directories inside the command - use `workdir` instead.",
      commandSection: powershellCommandSection(
        shellName,
        chain,
        platform === "win32" ? "\\" : "/",
        limits,
        defaultTimeoutMs,
      ),
    };
  }
  return {
    intro:
      "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.",
    workdirSection:
      "All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID using `cd <directory> && <command>` patterns - use `workdir` instead.",
    commandSection: bashCommandSection(chain, limits, defaultTimeoutMs),
  };
}

export function render(shellName, platform, limits, defaultTimeoutMs) {
  const selected = profile(shellName, platform, limits, defaultTimeoutMs);
  return {
    description: renderPrompt(DESCRIPTION_TEMPLATE, {
      intro: selected.intro,
      os: platform,
      shell: shellName,
      tmp: os.tmpdir(),
      workdirSection: selected.workdirSection,
      commandSection: selected.commandSection,
    }),
    parameters: parameterSchema(),
  };
}
