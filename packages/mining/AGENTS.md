# @plex/mining — AGENTS.md

PR-history mining (M4): pull a repo's GitHub review comments via the `gh` CLI, **denoise → record
provenance Incidents → embed → cluster → LLM-distill** each cluster into one Pitfall stored in
`@plex/knowledge`. This is how the knowledge base gets cold-started from a team's real review
history; reviews then retrieve those pitfalls, and `record_outcome`/`consolidate_knowledge` refine
them. Two paths share the mechanical half (`scanHistory`):

- **Agent-driven** (MCP `mine_scan` → the connected agent distills → `add_pitfalls`): rides the
  user's subscription, no API key. The engine adapters live in `packages/engine/src/mining.ts`
  (`scanForMining`, `addMinedPitfalls`).
- **Standalone** (`plex mine` / MCP `mine_history` → `mineHistory`): distills via a
  `CompletionProvider` from `src/llm.ts`.

Decisions: ADR-11 (mining loop), ADR-20 (LLM-only distillation), ADR-21 (scope) in
[docs/adr/README.md](../../docs/adr/README.md); richer-outcome plan in
[docs/design/outcome-signals.md](../../docs/design/outcome-signals.md); clustering math in
[docs/design/tuning.md](../../docs/design/tuning.md) §6.

## Module map

| File | Responsibility |
| --- | --- |
| `src/github.ts` | `gh`-CLI fetchers (`listPrs`, `fetchCommentsForPr`) + pure `groupThreads` (replies attached to their root comment; orphans dropped, reply-cycles guarded) |
| `src/classify.ts` | Denoise (`isSubstantive`) + coarse regex `categorize` (first-match-wins, security first) |
| `src/cluster.ts` | Pure clustering: `greedyCluster`, `adaptiveCosineThreshold` (μ+kσ), `centroid` |
| `src/distill.ts` | `llmDistill`: one cluster → one Pitfall (or `null` = SKIP); `minedPitfallId` |
| `src/llm.ts` | `CompletionProvider`s: `claude-cli` (default), `anthropic`, `openai`; `createCompletionProvider` → `null` when unusable |
| `src/outcome.ts` | `outcomeFor` (binary merged-signal); re-exports `outcomeWeight` (lives in `@plex/core`, applied by knowledge consolidation) |
| `src/mine.ts` | Orchestration: `scanHistory` (mechanical, no LLM) and `mineHistory` (scan + distill + store) |
| `src/types.ts` | `RawComment` (thread-grouped source unit), `MineResult` |

## The pipeline (`mine.ts`)

1. **List PRs**: `gh pr list --state <merged|all> --limit maxPrs` (`config.mining.maxPrs`, default 100).
   Sort by PR number — `order: 'oldest'` = chronological, default newest-first. Drop PRs in
   `alreadyScanned` (the cursor); `limit` caps how many *fresh* PRs this run takes.
2. **Denoise**: `isSubstantive` — trimmed length ≥ 15, ≥ 3 words, and not matching the anchored
   `TRIVIAL` regex (`^(lgtm|nit|ship it|done|thanks|+1|👍…)\b`). ~70% of comments are noise.
3. **Provenance Incidents**: each substantive comment → `Incident` id `inc:mined:<commentId>`,
   `source: 'mined'`, `snippet: body.slice(0, 300)`, `outcome: outcomeFor(c)` — deduped against
   existing incident ids so re-runs never duplicate.
4. **Embed + cluster**: one batched `embed()` over all bodies, then
   `threshold = adaptiveCosineThreshold(vectors, { fallback: config.mining.clusterThreshold })`:
   with `n < 8` vectors it returns the **fallback** (default `0.8` — tuned for real code embeddings;
   ≲0.7 sinks everything into one cluster); otherwise `clamp(μ + k·σ, 0.5, 0.97)` with `k = 3`,
   estimated from up to `sampleCap = 4000` pairwise cosines of the batch itself (embedding spaces are
   anisotropic — a fixed cut means something different per model). `greedyCluster` is single-pass: a
   vector joins the most-similar existing centroid when `sim >= threshold` **and** `sim > 0` (never
   merge orthogonal vectors even at threshold ≤ 0), else starts a cluster; centroids are running
   means. Clusters below `config.mining.minClusterSize` (default 1) are dropped.
5. **Distill (ADR-20 — LLM-only, never heuristic)**: `mineHistory` **throws** if
   `createCompletionProvider` returns `null` (no `claude` binary / missing key) — it never stores
   junk. `llmDistill` renders the comments *with their thread replies* (the discussion reveals
   dismissals) and asks for JSON; `{"skip": true}`, missing JSON, or an empty title → `null` (the
   model decides what's worth remembering; dismissed/intentional suggestions are skipped). LLM/transport
   errors **propagate** — a broken distiller must fail loudly, not silently skip every cluster.
6. **Mechanical pitfall fields** (the LLM supplies only the semantic content + keep/skip):
   `confidence = min(0.9, 0.3 + 0.1·n + 0.1·(merged/n))` (`n` = cluster size, `merged` = comments on
   merged PRs); `tier` = `codifiable` only on the exact string, else `judgmental`; **`scope` =
   `global` only on the exact string, else `repo`** (ADR-21 — project-specific lessons are kept,
   stamped with `repo`, and retrieval scopes them); id `pf:mined:<repo>:<title-slug>-<hashId(title)>`;
   `embedding` = the cluster **centroid**; `incidentIds` = the `inc:mined:*` ids (provenance, mandatory).
   Storage dedupes by **exact title** (`hasPitfallTitled`) — same in `addMinedPitfalls` (the
   `add_pitfalls` path, which embeds `` `${category}: ${title}\n${why}` `` server-side and defaults
   `scope` to `'repo'`, `confidence` to `0.6`).

**Outcome signal is coarse**: `outcomeFor` = `prMerged ? 'accepted' : 'rejected'`. Thread
`isResolved` and the resolving diff are not consulted, so `fixed`/`reverted` are never produced.

## The incremental cursor

Lives at `repoPaths(...).miningStateFile` = `<repo-data>/mining-state.json` —
**`~/.plex/repos/<id>/mining-state.json` by default** (in-repo `<repo>/.plex/mining-state.json` only
with the `PLEX_DATA_DIR=.plex` opt-in). Shape: `{ repo, scannedPrs: number[], lastRun }`; owned by
`packages/engine/src/mining.ts` (`loadMiningState`/`saveMiningState`), not this package — `scanHistory`
just receives `alreadyScanned` and returns the cumulative `scannedPrs`. Flags: `--reset` ignores the
saved cursor (re-scan everything; incident dedupe still prevents duplicates); `--all` mines unmerged
PRs too (`state: 'all'`); `--oldest` (CLI) scans chronologically *and* raises `maxPrs` to ≥ 1000 so the
oldest PRs are in the fetch window; `--limit <n>` bounds fresh PRs per run, the cursor advances so the
next run continues.

## Known gaps (code vs docs — verified)

- **Mining never produces `fixed`/`reverted` outcomes** — `outcomeFor` is binary (merged →
  `accepted`, else `rejected`); thread `isResolved` and the resolving diff are unused. The
  `outcomeWeight` table itself (core) IS applied by knowledge consolidation now; richer outcomes
  would make it bite on mined incidents too. See outcome-signals.md.
- **`mine_scan` can't do `--oldest`/`--limit`**: `scanForMining` (engine) accepts `MineRepoOptions`
  but only forwards `reset`/`state` to `scanHistory` — chronological/bounded mining is CLI-only.
- **The cursor advances at scan time**, before the agent distills: if `mine_scan` clusters are never
  passed to `add_pitfalls`, those PRs won't be re-clustered without `--reset` (their Incidents are
  recorded, though).
- **Stale "heuristic" wording**: the `scanHistory`/`mineHistory` docstrings and the `mine_history`
  MCP description still mention a heuristic distiller; reality is LLM-only — `mineHistory` throws.

## Testing

All tests here are **vitest units** (`pnpm test:unit`), colocated `*.test.ts` — fully offline:
`mine.test.ts` runs `mineHistory` end-to-end with an injected `opts.fetch` (fake GitHub) +
`opts.llm` (scripted distiller) and `FakeEmbeddingProvider`; `cluster.test.ts` covers the adaptive
threshold band, the ≥-boundary, and the anisotropic centroid-sink regression; `classify.test.ts`,
`mining.test.ts` (threads/denoise/distill), `outcome.test.ts` round out the rest. No Kùzu anywhere
in this package, so nothing needs `integration.mts`. The real `gh`/LLM paths are exercised only by
using `plex mine` against a live repo.
