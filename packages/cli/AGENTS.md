# @plex/cli

The `plex` CLI — a thin human-facing wrapper over `@plex/engine`. Agents use the MCP server
(`@plex/mcp-server`) instead; both surfaces call the **same engine functions**, so behavior and
storage (`~/.plex/repos/<id>`, the brain, the knowledge base) are shared. Built by tsup into
`dist/plex.js` (shebang preserved → the published `plex` bin; ADR-19: run under node, never tsx).

## Module map

- `src/index.ts` — usage text, the command switch, `runInit`, spinner, git-repo gate, `printReview`.
- `src/parse.ts` — minimal argv parser (`--flag value`, `--flag=value`, bare `--flag`; no deps).

## Commands (`src/index.ts`)

- `init` — one-command setup: prompt for an embedding provider/key → `writeHomeConfig()`
  (`~/.plex/config.json`), then offer to index (git repos only). Does **not** register an MCP
  server (the plugin provides it — avoids a duplicate `plex` entry).
- `doctor` — two checks: `embeddingReady(config)` and whether the repo's `graphDir` exists. (The
  MCP `doctor` tool is different — build staleness + effective config.)
- `index [--incremental]` — `indexRepo`; gated on being inside a git work tree (blast radius is
  built from git co-change history). Same function the review's auto-index child runs.
- `review [--staged | --branch <base> | --pr <n>] [--json] [--html <file>]` — `assembleReviewContext`
  only. **Intentionally omitted from USAGE**: the CLI has no LLM, so it can only *assemble* context,
  not produce first-principles findings — a real review must run in the isolated reviewer agent
  (ADR-02). Kept for `--html` viz (`reviewContextToHtml`), `--json` piping, and the brain E2E.
- `reconcile [--pr <n> | --staged | --branch <base>]` — `reconcileOutcomes` (ADR-28); always prints
  the `reason` so `accepted: 0` is never a black box.
- `eval` — `rankingQuality`: offline nDCG of ranking vs outcomes + a re-weight readiness verdict
  (measurement only; [`docs/design/tuning.md`](../../docs/design/tuning.md)).
- `blast --files <a,b>` — `blastRadius` for a file set (no diff).
- `verdict <findingId> <accept|reject|waive|acknowledge>` / `verdicts` — `submitVerdict` /
  `readVerdicts`. Note: the CLI calls `submitVerdict` **without a target**, so it writes
  `verdicts.jsonl` (+ a knowledge incident on accept) but not a brain `Verdict` node; the MCP
  `record_outcome` passes the `reviewTargetFor` target and does both.
- `analyze [--reset] [--all] [--oldest] [--limit N] [--threshold X] [--min-cluster N]` — `analyzeRepo`,
  standalone LLM distillation (errors without an LLM, ADR-20); `--oldest` raises the PR fetch
  ceiling to find the chronological start.
- `consolidate` — `consolidateKnowledge`: recompute pitfall confidence from recorded incident outcomes (recency-decayed + pruned, ADR-42).
- `sweep` — `sweepRepo`: the background maintenance worker (ADR-43). Resolves `main` and runs the 4 jobs (reconcile loop-closure, graph freshness, consolidate decay, analyze). Normally auto-spawned detached by a review; this is the manual entry + what the detached spawner runs.
- `serve [--port N] [--stop] [--status] [--foreground]` — the optional local visualization daemon
  (ADR-45, `@plex/viz-server`). **On-demand by default** (it's a viewer, not a capturer): the default
  mode is idempotent — open the running UI or spawn a detached one (`http://127.0.0.1:2288`).
  `--foreground` IS the daemon (what the detached child runs; also what the MCP spawns when the user
  opts into always-on via `ui.autoStart`/`PLEX_UI_AUTOSTART`). Orchestration lives in `src/serve.ts`;
  the server never holds a Kùzu handle, so it can't block a review.

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
