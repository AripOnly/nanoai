# Deployment and operations

This guide covers a long-running NanoAI gateway: automatic crash recovery,
systemd / Windows Task Scheduler setup, logs, shutdown, and retention.

## Process model

```
systemd / Task Scheduler / `nanoai gateway start`
                  │
                  ▼
          gateway/daemon.js        (small supervisor, owns restart loop)
                  │  spawn + pipe stdout/stderr
                  ▼
          gateway/server.js        (HTTP + SSE + agents)
```

The daemon is intentionally separate from the gateway. If the gateway crashes,
the daemon still exists and can start a new child. A gateway cannot restart
itself after a hard crash.

`npm start` and `nanoai gateway start` both use the daemon. For a debug run
without supervision, use `npm run start:foreground`.

## Automatic crash recovery

The daemon restarts the gateway when the child exits with a non-zero code or
is terminated by a signal. The restart delay doubles from 1 second to a
30-second ceiling. A child that stays up for 60 seconds resets the counter.

A clean exit (`code 0`, for example after `POST /api/v1/system/shutdown` or
Ctrl+C) is final: the daemon does not restart it.

Tuning (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `NANO_RESTART_BASE_MS` | `1000` | First retry delay |
| `NANO_RESTART_MAX_MS` | `30000` | Maximum retry delay |
| `NANO_RESTART_LIMIT` | `0` | Consecutive crashes before giving up; `0` = unlimited |
| `NANO_RESTART_STABLE_MS` | `60000` | Uptime that resets the crash counter |
| `NANO_LOG_MIRROR` | auto | `1` mirrors daemon events to stdout (journald/Task Scheduler); `0` disables it |
| `NANO_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `fatal` |

When `NANO_RESTART_LIMIT` is reached the daemon exits with code 1. An outer
supervisor (systemd `Restart=on-failure`, Task Scheduler "Restart on failure")
can then take over.

## Linux: systemd

Create `/etc/systemd/system/nanoai.service`:

```ini
[Unit]
Description=NanoAI Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nanoai
Group=nanoai
WorkingDirectory=/opt/nanoai
ExecStart=/usr/bin/node /opt/nanoai/gateway/daemon.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=25
KillMode=mixed
Environment=NANO_DATA_DIR=/var/lib/nanoai
Environment=NANO_WORKSPACE=/srv/nanoai-workspace
Environment=NANO_LOG_MIRROR=1

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nanoai
systemctl status nanoai
journalctl -u nanoai -f
```

The daemon handles the gateway's graceful stop. `KillMode=mixed` and
`TimeoutStopSec=25` give it time to close SSE streams before systemd escalates.

## Windows: Task Scheduler

1. Open **Task Scheduler → Create Task** (not "Basic Task").
2. **General**: run whether the user is logged on or not; uncheck "Stop the
   task if it runs longer than…".
3. **Triggers**: "At startup" or "At log on", as appropriate.
4. **Actions → New**:
   - Program/script: `C:\Program Files\nodejs\node.exe`
   - Add arguments: `"C:\path\to\nanoai\gateway\daemon.js"`
   - Start in: `C:\path\to\nanoai`
5. **Settings**:
   - Enable "If the task fails, restart every **1 minute**", attempts **3**.
   - Enable "Stop the existing instance" if you use one fixed task.
6. Set the environment variables (`NANO_DATA_DIR`, `NANO_WORKSPACE`) in the
   system environment or use a small `.cmd` wrapper.
7. Start the task, then check:

```powershell
nanoai gateway status
nanoai gateway log 30
```

Stopping the task sends a signal that may not be graceful on Windows. Prefer
`nanoai gateway stop`, which uses the authenticated HTTP shutdown endpoint and
the stop marker before falling back to `taskkill /T`.

## Graceful shutdown endpoint

The authenticated endpoint shuts down the same way as a signal:

```bash
curl -X POST http://127.0.0.1:3060/api/v1/system/shutdown \
  -H "Authorization: Bearer $NANO_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"shutdown"}'
```

PowerShell:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:3060/api/v1/system/shutdown `
  -Headers @{ Authorization = "Bearer $env:NANO_GATEWAY_TOKEN" } `
  -ContentType "application/json" `
  -Body '{"confirm":"shutdown"}'
```

The response is `202 Accepted`; live turns are aborted, pending work is
disposed, and the process exits 0. The daemon then exits without restarting.

## Logs

| File | Writer | Rotation |
| --- | --- | --- |
| `<data>/logs/gateway.log` | daemon + gateway (JSON lines) | 5 MB, 3 copies |
| `<data>/logs/gateway.console.log` | launcher only | truncated on every start |
| `<data>/audit.log` | request audit trail (JSONL) | 5 MB, 3 copies |
| `<data>/jobs/*/output.log` | background jobs | 7 days / 100 MB total |
| `<data>/attachments/*` | image/PDF cache | 7-day sweep, at boot and daily |

The gateway is structured JSON, one entry per line. Read it with
`nanoai gateway log [n]` or a JSON-aware log viewer. Secrets in field names
(`token`, `api_key`, `password`, …) are redacted; the one-time first-boot token
is intentionally printed to the console so the operator can copy it.

## Health and retention

- `GET /health` is unauthenticated for monitors. `200` means ready; `503`
  means degraded (settings, models, database, jobs, or skills).
- `scripts/backup.mjs` keeps the 7 newest online SQLite backups.
- `scripts/restore.mjs` refuses to run while the gateway is alive.
- Run `npm run doctor` before a fresh deployment.
