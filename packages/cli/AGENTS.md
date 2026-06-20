# @plex/cli

The `plex` CLI — a thin human-facing wrapper over `@plex/engine`. Agents use the MCP server
(`@plex/mcp-server`) instead; both surfaces call the **same engine functions**, so behavior and
storage (`~/.plex/repos/<id>`, the brain, the knowledge base) are shared. Built by tsup into
`dist/plex.js` (shebang preserved → the published `plex` bin; ADR-19: run under node, never tsx).

## Module map

- `src/index.ts` — usage text, the command switch, `runInit`, spinner, git-repo gate, `printReview`.
- `src/parse.ts` — minimal argv parser (`--flag value`, `--flag=value`, bare `--flag`; no deps).

## Commands (`src/index.ts`)

The user-facing CLI is **four commands** (ADR-51): the reviewer (`/plex:review`) and history analysis
(`/plex:analyze`) run in the agent, not the CLI.

- `init` — one-command setup: prompt for an embedding provider/key → `writeHomeConfig()`
  (`~/.plex/config.json`), then offer to index (git repos only). Does **not** register an MCP
  server (the plugin provides it — avoids a duplicate `plex` entry). Points the user to `/plex:analyze`
  for PR-history seeding (no longer seeds itself).
- `index [--incremental]` — `indexRepo`; gated on being inside a git work tree (blast radius is
  built from git co-change history). Same function the review's auto-index child runs.
- `serve [--port N] [--stop] [--status] [--foreground]` — the optional local visualization daemon
  (ADR-45, `@plex/viz-server`). **On-demand by default** (it's a viewer, not a capturer): the default
  mode is idempotent — open the running UI or spawn a detached one (`http://127.0.0.1:2288`).
  `--foreground` IS the daemon (what the detached child runs; also what the MCP spawns when the user
  opts into always-on via `ui.autoStart`/`PLEX_UI_AUTOSTART`). Orchestration lives in `src/serve.ts`;
  the server never holds a Kùzu handle, so it can't block a review.
- `sweep` — `sweepRepo`: the background maintenance worker (ADR-43). Resolves `main` and runs the 3 jobs (reconcile loop-closure, graph freshness, consolidate decay). Normally auto-spawned detached by a review; this is the manual entry + what the detached spawner runs.

**Internal (omitted from USAGE):** `review [--staged|--branch <base>|--pr <n>] [--json]` and
`blast --files <a,b>` — `assembleReviewContext`/`blastRadius` JSON dumps kept **solely** as the
node-E2E harness's child-process entry points (ADR-17 isolation; `brain-check`/`deleted-radius-check`
use `review --json`, `cochange-check` uses `blast`). The CLI has no LLM, so it only assembles context —
a real review runs in the isolated agent (ADR-02). (`--html` was dropped with `viz.ts`.)

Diff-source flags map to the same `DiffSource` the MCP tools take: `--pr` → `source: 'pr'`,
`--staged`/`--branch <base>` → local modes; default is local/`working`.

## Gotchas

- Commands default `repoPath` to `process.cwd()`; an explicit positional path still works.
- `withSpinner` degrades to a single plain line on non-TTY (CI/piped) output.
- Config comes from `loadConfig()` per invocation — env (`PLEX_DATA_DIR`, `PLEX_KNOWLEDGE_DIR`,
  `PLEX_EMBEDDING_PROVIDER`, …) > `~/.plex/config.json` > defaults (see `@plex/core` /
  `@plex/engine/src/config-load.ts`).

## Testing

- `src/parse.test.ts` (vitest unit) — the argv parser.
- Command behavior is engine behavior; the node-only E2Es (`pnpm test:brain`,
  `pnpm test:worktree`) drive this built CLI end to end as the shipped runtime.
