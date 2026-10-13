# NanoAI — Personal AI Agent

NanoAI is a personal AI assistant that runs on your own machine, 24/7. One agent,
many doors: terminal (CLI), gateway API with live streaming, and a workspace
folder where it reads, writes, and organizes files for you.

> **Status:** actively developed. The test suite (`npm test`) is the contract —
> every tool below is covered by it.

## Features

- **10 agent tools**: read (text, folders, images, PDF, Word, Excel), write
  (files, folders, Word, Excel), edit (fuzzy string replacement with diffs),
  shell (streaming, timeouts, permission safety net), glob, grep, webSearch,
  webFetch, plus Word/Excel creators.
- **Live streaming** — assistant text, tool calls, and live tool output stream
  over Server-Sent Events; long outputs truncate with full logs saved to disk.
- **Conversational approval** — destructive actions are confirmed in chat, no
  popups.
- **Persistent memory** — sessions, turns, and token usage in SQLite.
- **Ripgrep-powered search** — the `rg` binary is used when present, otherwise
  downloaded automatically on first use.

## Requirements

- **Node.js 22+** (24 recommended) — plain Node, no build step, no native
  dependencies.
- A **Google Gemini API key** ([AI Studio](https://aistudio.google.com/),
  free tier works).
- Windows, macOS, or Linux.

## Install

```bash
npm install -g @ariponly/nanoai
nanoai -h                    # all commands
```

## Quickstart (from source)

```bash
git clone <repository-url>
cd agent-ai-nano
npm install
npm test
npm link                     # optional: use the local code as `nanoai`
```

Configure, then run:

```bash
# The nanoai command (works from any folder after npm install -g / npm link)
nanoai gateway start         # backend in the background (+ web UI)
nanoai cli                   # enter chat mode (/exit quits)
nanoai web                   # print the dashboard URL
nanoai gateway stop          # stop the backend

# Or with npm scripts from the repo folder:
npm start                  # gateway in the foreground (debug logs live)
npm run chat               # chat UI (needs the gateway running)
```

The web dashboard is served by the gateway itself from a prebuilt client —
included in the npm package (built with `npm run build:web` before packing).
On first boot the gateway generates a token (shown once in the console) and
creates the default workspace at `~/nano-workspace`. Open the chat, set your
provider key with `/provider`, pick a model with `/model`, and talk to NanoAI.

## Configuration

Your data lives in `~/.nanoai/` (override with `NANO_DATA_DIR`): `nano.config.json`,
the SQLite database, attachments, logs, and backups. First run adopts data
from older layouts automatically. Shipped defaults live in `config/` next to
the code. Environment variables (all optional):

| Variable                 | Default                    | Purpose                                    |
| ------------------------ | -------------------------- | ------------------------------------------ |
| `NANO_DATA_DIR`          | `~/.nanoai`                | Per-user runtime data (config, database)   |
| `NANO_WORKSPACE`         | `~/nano-workspace`         | Default working directory for all tools    |
| `NANO_WEBSEARCH_PROVIDER`| per-session split          | `exa` or `parallel` to pin web search      |
| `NANO_GATEWAY_URL`       | `http://localhost:3060/api/v1` | Gateway address for the CLI            |
| `PORT`                   | `3060`                     | Gateway listen port                        |
| `EXA_API_KEY`            | —                          | Optional: higher web-search limits         |

For 24/7 operation, run the gateway as a system service (Task Scheduler on
Windows, systemd/pm2 on Linux) with `NANO_WORKSPACE` set explicitly.

## Repository structure

```
agent-ai-nano/
  app.jsx                # CLI entry (npm run chat)
  bin/nanoai.js          # the `nanoai` command (gateway supervision + chat)
  apps/console/          # detached gateway supervisor (start/stop/status/log)
  gateway/               # HTTP+S SSE backend (routes → controllers → services)
    server.js            # boot + graceful shutdown
  src/
    agents/              # agent loop, tool dispatch, registry, compaction
    tools/
      read/ write/ shell/ web/   # one folder per tool family
      edit.js  glob.js  grep.js   # single-module tools
      shared/                    # shared helpers (attachments, truncate, rg, workspace)
    shared/              # cross-cutting helpers (data dir, naming, events)
    config/              # config module (reads ~/.nanoai/nano.config.json)
    llm/providers/google/        # model provider (request/stream/feed)
    session/             # SQLite session store
    prompts/             # agent instructions + work environment
  apps/cli/              # Ink terminal UI (components/hooks/lib)
  apps/web/              # web client (dist/ ships inside the npm package)
  test/suite/            # node:test suites — run with npm test
  config/                # shipped defaults: models catalog + config example
  scripts/               # doctor / backup / restore
```
Runtime data (database, `nano.config.json`, attachments, logs, backups) lives
in `~/.nanoai/` — never inside the install folder, so global installs and
updates cannot wipe it.

Rules: dependencies flow one way (`apps/gateway → services → agents →
tools → shared`), sibling folders never import each other (shared code lives
in `tools/shared/`), cross-folder imports use the `#src/` alias, state lives
only in SQLite, tool results use the `{ success, … }` envelope, errors are
plain English. The `architecture` test suite enforces the import rules.

## Testing

```bash
npm test                # full suite, must stay green before every change
node --test test/suite/<name>.test.js   # single area
```

## Operations

```bash
npm run doctor          # preflight health check (run before booting)
npm run backup          # online SQLite backup with 7-copy retention
npm run restore <file>  # validated restore (refuses while gateway runs)
```

Database schema upgrades are versioned (`src/session/migrations.js`,
`PRAGMA user_version`) and apply automatically at gateway boot.

## Security model

- File tools are jailed to the workspace; shell has a hard blocklist for
  catastrophic commands (disk, boot, raw devices, remote-code pipes) that no
  approval can override.
- Gateway requests need a bearer token; agent routes are rate-limited.
- The web app `dist/` build and all secrets stay out of git (see `.gitignore`).

## License

MIT — see [LICENSE](LICENSE).
