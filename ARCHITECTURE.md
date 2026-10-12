# ARCHITECTURE

Computed intent of this codebase: a modular monolith. One deployment (the
Gateway process), code split into modules with enforced boundaries. Not
microservices (no independent deploys), not a multi-package monorepo (single
`package.json`, plain Node, no build step).

## Dependency direction (one way, never back)

```
apps/*, gateway  →  services  →  agents  →  tools  →  shared
     \_________________↓_____________________________/
                        config, prompts, session, llm
```

- Lower layers never import upper layers. In particular: **tools never
  import agents** (capabilities are injected via tool context at runtime).
- Sibling folders never import each other. Code needed by two or more tools
  lives in `src/tools/shared/` behind its barrel (`src/tools/shared/index.js`).
- Cross-folder imports use the `#src/` alias (`package.json` → `imports`).
  Same-folder imports stay relative. The single documented exception is
  `src/llm/llm.js` reading the root-level model catalog
  (`../../config/models.json`).
- `test/suite/architecture.test.js` enforces all of the above. If it fails,
  the design regressed — fix the code, not the test.

## Data and state

- Runtime state lives only in SQLite (`src/session/`). No new JSON/JSONL
  sidecar stores; files under the data dir (`~/.nanoai/`, see
  `src/shared/data-dir.js`) are caches/attachments with
  retention, never source of truth.
- Schema changes ship as guarded migrations (`src/session/migrations.js`,
  tracked by `PRAGMA user_version`) applied in one transaction at boot.
  `scripts/backup.mjs` (online, retention 7) and `scripts/restore.mjs`
  (validates, refuses while the gateway runs, safeguards pre-restore) own
  disaster recovery; `scripts/doctor.mjs` owns preflight health.
- Attachments (images, PDFs) are stored by reference (`attachments/`
  inside the data dir)
  and sent to the LLM exactly once per id (see `google.js` expansion +
  `sentAttachments` seeding).

## Tool contract

- Every tool returns `{ success: true, … }` or `{ success: false, error }`.
  Errors are plain English, validated inputs, no exceptions leaking to the
  model (toolExecute converts throws the same way).
- Tool results that the model must see live in `output`; machine fields
  (`count`, `truncated`, `outputPath`, …) ride alongside.
- Destructive builtins (shell catastrophic commands) are hard-blocked and no
  approval can override them. Day-to-day approvals happen in conversation.

## Prompts

- `createInstruction()` builds the system prompt fresh every turn: identity,
  tool schemas come from the registry, environment from `workEnv.js`.
- WorkEnv states the current location, home, reachable project areas, and the
  absolute-path-first strategy. Tool empty-results always state WHERE they
  searched so the model self-corrects instead of guessing patterns.
