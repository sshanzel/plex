# @plex/mcp-server

The MCP tool surface (stdio). This is the integration seam (ADR-02): any coding agent connects
here, gets grounded review context, and records findings/verdicts — the agent brings the LLM, the
server stays model-agnostic and runs in a process separate from whoever authored the code. It is a
thin layer: every tool handler is a zod-validated wrapper over one `@plex/engine` function. Read
the root `AGENTS.md` first; decisions in [`docs/adr/README.md`](../../docs/adr/README.md).

## Module map

- `src/index.ts` — the server: version/build-mtime capture, `McpServer` + `instructions`, the per-call `guard`, and all 15 tool registrations.
- `src/doctor.ts` — `buildDoctorReport()`: pure staleness/health report (unit-tested in `doctor.test.ts`).

## The 14 tools

| Tool | Engine call | Diff-source params |
|---|---|---|
| `index_repo` | `indexRepo` | — (`repoPath`, `incremental`) |
| `get_review_context` | `assembleReviewContext` | yes |
| `get_blast_radius` | `blastRadius` | — (`files`) |
| `get_deterministic_findings` | `getDeterministicFindings` | yes |
| `submit_findings` | `rankReviewFindings` | yes (+ `findings[]`, `includeDeterministic`) |
| `record_outcome` | `submitVerdict` (target via `reviewTargetFor`) | yes |
| `reconcile_outcomes` | `reconcileOutcomes` | yes |
| `get_relevant_knowledge` | `getRelevantKnowledge` | — (`query`, `topK`) |
| `consolidate_knowledge` | `consolidateKnowledge` | — |
| `propose_promotions` | `getPromotions` (codifiable → ast-grep rule stubs) | — |
| `mine_scan` | `scanForMining` | — (`reset`, `state`, `order`, `limit`) |
| `add_pitfalls` | `addMinedPitfalls` | — (`pitfalls[]`) |
| `mine_history` | `mineRepo` | — (`reset`, `state`, `order`, `limit`) |
| `doctor` | `buildDoctorReport` | — |

**Diff-source params** (`diffSourceShape`, all optional): `source: 'local' | 'pr'`,
`mode: 'working' | 'staged' | 'branch'`, `baseRef`, `pr`. Defaults (resolved in
`@plex/engine/src/diff.ts` + `@plex/ingest`): no `source`/`pr` → local; no `mode` → `working`;
branch mode without `baseRef` → `main`. `repoPath` defaults to `process.cwd()` everywhere.
The five diff-source tools must be called with the **same** source for one review so the brain
target (`reviewTargetFor(repoPath, src)`) agrees across context → findings → outcomes → reconcile.

## The logic

- **`guard` re-reads config on every tool call** (`config = loadConfig()` in `src/index.ts`), so
  edits to `~/.plex/config.json` or `PLEX_*` env (key, `autoComment`, thresholds) apply with **no
  restart**. Failures return `isError` text (`"<label> failed: …"`) instead of throwing into the
  transport.
- **Config is live, code is not.** A long-lived stdio process runs the build it loaded at spawn;
  a `pnpm build` on disk does nothing until the client reconnects/respawns. `doctor` makes this
  visible: it compares the mtime of the running file captured at load (`LOADED_BUILD_MS`) with the
  file's mtime *now* — `stale: true` (with a 1ms jitter guard, `src/doctor.ts`) means "reconnect
  Plex to pick up the newer build". It also reports version, node, pid, and the *effective* config
  (embedding provider, data/knowledge dirs).
- **Version is single-sourced** from the `package.json` shipped beside the bundle
  (`dist/ → ../package.json`) — never hand-bumped in code.
- **`instructions`** in the server constructor are surfaced to the client so tool-search can find
  Plex when MCP tools are deferred in a crowded session (pair with `"alwaysLoad": true` in the
  `.mcp.json` registration — see root `AGENTS.md`).
- The shebang in `src/index.ts` line 1 is preserved by tsup into `dist/plex-mcp.js` so the
  published `plex-mcp` bin is directly spawnable.

## Invariants & gotchas

- **ADR-02**: the server returns review state as facts (rounds, comments, verdicts) — it never
  stores or replays an agent's reasoning.
- **ADR-19**: clients must spawn the **built** `dist/plex-mcp.js` under node, never tsx (the repo's
  `.mcp.json` and the plugin's npx command both do). The tsx Kùzu open-limit (ADR-17) would crash a
  tsx-run server.
- **Embeddings optional (ADR-30)**: tools degrade rather than fail — `get_relevant_knowledge`
  falls back to lexical (keyword) retrieval; `reconcile_outcomes` falls back to locality-only. Exception:
  `mine_scan`/`mine_history`/`add_pitfalls` error without a provider (clustering needs vectors).
- **`record_outcome` / `reconcile_outcomes` are internal learning-loop bookkeeping** — agents call
  them silently and best-effort (the `instructions` say so); a dropped call is recovered by the next
  review's locality-based fix inference (ADR-36). Never make an agent surface their success/failure.
- The server is **stateless per call** (brain/graph read from disk), so a "disconnected" stdio
  status is never a reason to skip a step — the next call respawns it (~400ms).

## Testing

- `src/doctor.test.ts` (vitest unit) — the pure staleness report.
- The tool handlers themselves are thin; their logic is tested in `@plex/engine` (tsx integration
  scenarios + the node-only `pnpm test:brain` / `pnpm test:worktree` E2Es, which drive the built
  CLI — same engine code paths the server calls).
