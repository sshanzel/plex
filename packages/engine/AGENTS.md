# @plex/engine

The orchestration layer behind every MCP tool and CLI command. The MCP server (`@plex/mcp-server`)
and CLI (`@plex/cli`) are thin surfaces over this package: it composes ingest + code-graph +
neighborhood + deterministic + findings + knowledge + review-history analysis into the actual review flow, and owns
the PR brain. Read the root `AGENTS.md` first; decisions live in [`docs/adr/README.md`](../../docs/adr/README.md).

## Module map

**Config & paths**
- `src/config-load.ts` — `loadConfig()`: defaults < `~/.plex/config.json` < `PLEX_*` env < explicit overrides (precedence verified in that order in code).
- `src/home-config.ts` — read/merge-write `~/.plex/config.json` (chmod 600; holds the embedding API key).
- `src/paths.ts` — `repoPaths()`: where a repo's data lives (`~/.plex/repos/<id>` by default: `graph.kuzu`, `brain.kuzu`, `verdicts.jsonl`, `analyze-state.json`, `log/events.jsonl`, `head.sha`, `embed-cache.json`, and the ADR-43 sweep sidecars `sweep-state.json`/`sweep-last.txt`/`sweep.lock` + `base.sha`); `ensureDataDir()` makes an in-repo data dir self-ignoring.
- `src/embed-cache.ts` — `cachedEmbed`/`loadEmbedCache`: a content-addressed embedding cache (`embed-cache.json`) for STABLE, recurring texts (prior-finding titles), so an N-round PR embeds each title once, not once per round. Best-effort; doubles as local proof embeddings actually fired (a key-less "voyage" never writes here).

**Diff & identity**
- `src/diff.ts` — `DiffSource` (`source: local|pr`, `mode: working|staged|branch`, `baseRef`, `pr`) → `NormalizedDiff` via `@plex/ingest`.
- `src/change-context.ts` — the author's *stated intent* (PR title/body, or commit subjects for branch mode) as a fact to check the code against.
- `src/target.ts` — `reviewTarget` / `reviewTargetFor`: the brain's correlation key (see invariant below).
- `src/guards.ts` — pure decision helpers extracted so silent-failure guards are unit-testable without opening Kùzu: `recordableHeadSha` (carry the last anchor forward when the current head is unresolved rather than skipping the round — keeps comments + avoids a false split-signature), `priorRoundHeadSha` (anchor attribution on the round *before* this one so a crash-retry that already recorded the current round reproduces the same changed-without-feedback/fix-inference signal — fixes the Linux Kùzu close-time SIGSEGV replay), `projectableOutcome`/`OUTCOME_BY_KIND` (skip a brain outcome projection for an empty findingId — a no-op MATCH that re-opens the finding). Imported by `brain.ts`/`review.ts`/`knowledge.ts`.

**Review context & indexing**
- `src/review.ts` — `indexRepo` (full/incremental/worktree-seeded, ADR-32), `assembleReviewContext` (the heart — see below), `blastRadius`.
- `src/code-path.ts` — **code-path memory** (ADR-47), PURE (no Kùzu/embeddings): `matchCodePath` intersects retrieved pitfalls' incident history against the diff's changed symbols (`nb.changed`) + co-change neighbours (`nb.neighbors`) — symbol-key (`file#name`) → line-overlap → file → coupled ladder; a prior `fixed`/accepted at a touched symbol is a `regressionSentinel`. Returns `CodePathAlert[]` + `applyCodePathBoost` (folds a bounded boost into the retrieval ranking). Called in `assembleReviewContext` after knowledge retrieval; the accept path in `knowledge.ts` anchors the incident's `symbol`/`line` from the brain finding.

**PR brain & reconcile**
- `src/brain.ts` — the durable JSONL **lineage layer** (ADR-46, replaces the Kùzu brain): append-only event log per target under the base repo's `lineage/`, folded by `@plex/core` `foldLineage`; round state, finding/verdict writes, `rankingSamples`, `openTargets` (the sweep's work list — open non-`note` findings + latest round head/baseRef).
- `src/reconcile.ts` — `reconcileOutcomes` (standalone "did the author fix these?") + `recordFixAccepts` (shared with the in-review fix inference, ADR-28).
- `src/sweep.ts` — **the background maintenance worker (ADR-43)**: `runMaintenance`/`sweepRepo` targets `main` (`resolveMainRepoPath`) and runs 3 idempotent jobs — Reconcile (loop closure → global KB), GraphFreshness (re-index main in an isolated child), Consolidate (ADR-42 decay/prune — makes it live). (The Analyze job was removed with the standalone distiller — distillation is agent-only, ADR-51.) Spawned detached + debounced by `maybeSpawnSweep` (review.ts) at the end of `assembleReviewContext` + MCP `reconcile_outcomes`. Pure gates `headAdvanced`/`isDebounced`/`jobDue` keep it idempotent; sidecars `sweep-state.json`/`sweep-last.txt`/`sweep.lock`/`base.sha` (paths.ts). See [docs/design/maintenance-worker.md](../../docs/design/maintenance-worker.md).

**Findings & verdicts**
- `src/findings.ts` — `getDeterministicFindings`; `rankReviewFindings`: merge agent + deterministic findings, blast enrichment from the sidecar, semantic waivers (ADR-27), rank, persist to brain, optional PR auto-comment.
- `src/pr-comment.ts` — pure `buildReviewPayload` (dedup vs prior rounds, inline vs summary) + best-effort `postFindingsToPr` (ADR-34).
- `src/verdicts.ts` — append-only `verdicts.jsonl`; `loadWaivers` turns `waive`/`acknowledge`/`reject` verdicts into suppression rules; `replaceVerdicts` (atomic temp+rename) + `migrateWaiverAnchors` re-anchor `file`/`symbol` across a rename (ADR-53).
- `src/rename-migrate.ts` — `renameMapFromDiff` (a review diff's `oldPath`→`path`) + `migrateRenamedAnchors`: re-anchors code-path-memory Incidents (`@plex/knowledge` `migrateIncidentAnchors`) and symbol-scoped Waivers across file renames (ADR-53), run in `assembleReviewContext` before the stores are read. Best-effort, no-op without renames, idempotent.
- `src/knowledge.ts` — knowledge store wiring (retrieval, seed, consolidate, promotions) + `submitVerdict` (verdict → JSONL + incident-on-accept + brain projection + audit). An accept without an explicit `pattern` runs `inferPitfallId` (embedding cosine ≥ `adaptiveFloor(0.7, …)`, lexical ≥ 0.45 for vectorless/key-less; conservative — no match beats a wrong match) so first-principles accepts reinforce pitfalls too. **Suppression (ADR-39/41):** `learnSuppression` records a dismissal on a negative pitfall keyed by a deterministic `suppressKey` OR — when there's none and a provider exists — by the finding's **title embedding** (match-or-mint by cosine ≥ `0.82`, first-principles suppression); `loadSuppressions` reads the live, **recency-decayed** tier (`decayedCounts` — reject fades / waive persists / corrections durable) and returns the embedding for first-principles ones so `findings.ts` routes them through the semantic-waiver path. **Location scope (ADR-48):** the dismissal incident is anchored to the finding's `file#name` symbol (resolved from the brain finding in `submitVerdict`, hoisted above `recordVerdict`/`learnSuppression`); dedup is per-`(pitfall, file, symbol)`; `loadSuppressions` derives `repoWide` + `symbols` on the decision (fail-open to `repoWide` when any incident is symbol-less or the scope was an explicit `pattern-repo`/`category-*`), and `rankFindings` applies a symbol-scoped decision only at the matching symbol — so one dismissed `console.log` never buries the rule repo-wide. `acknowledge`/`waive` are tightened the same way via `Waiver.symbol` + the `waiverMatches` symbol gate.

**Analysis, eval, audit**
- `src/analyze.ts` — incremental PR-review-history scan cursor; `scanForAnalysis`/`addAnalyzedPitfalls` (the agent-driven path — `analyze_scan`/`add_pitfalls`), `refreshAnalyzedOutcomes` (ADR-50 backfill). Uses the `@plex/distill` package as the clustering/scan technique; the connected agent distills (ADR-51).
- `src/ranking-eval.ts` — `rankingQuality`: offline nDCG of `signal` vs outcomes; measurement only ([`docs/design/tuning.md`](../../docs/design/tuning.md)).
- `src/audit.ts` — ADR-24 append-only audit log: what was PROVIDED and SUBMITTED, never chain-of-thought (ADR-02).

## The review-context assembly (`assembleReviewContext`, src/review.ts)

Order matters; each step feeds the next:

1. **Diff + stated intent** in parallel (`resolveDiff`, `resolveChangeContext`).
2. **Auto-index on first use** — no graph → `indexIsolated()` spawns `node dist/plex.js index` as a child. Isolation is the ADR-17 constraint: tsx (and to a lesser degree any single process) tolerates only a few Kùzu `Database` opens, and a review already needs **one open for the neighborhood + one for the brain**; indexing in-process would be a third. In dev/tsx `indexIsolated` no-ops (no built CLI beside `argv[1]`).
3. **Staleness check + drift refresh (ADR-25/36)** — read the sidecar `head.sha` (no Kùzu open), and if HEAD is definitively ahead, refresh incrementally in the same isolated-child way. The review is the *only* refresh trigger (no git hooks, ADR-36). Committed deletions: `indexRepo` captures a deleted file's direct dependents into the **`deleted-neighbors.json` sidecar** (`captureDeletedNeighbors`, one short extra open) BEFORE the update DETACH-DELETEs its node, and the review merges sidecar entries for the diff's deleted files after the walk — on ANY round, not just the one that triggered the refresh (dogfood round-1 caught the erased radius; round-2 caught that the first fix only covered the refresh-coinciding round).
4. **One code-graph open** — repo meta, `computeNeighborhood` (blast radius), coupling *among* changed files (for the review plan), coupling degrees; then close. A `blast-map.json` sidecar is written here so `submit_findings` can enrich per-finding `blastRadius` later **without another Kùzu open**.
5. **Review plan** — `reviewPlan()` (pure, `@plex/findings`) partitions changed files by coupling and computes surface; returned as metadata for angle-based sub-agent orchestration ([`docs/design/angle-review.md`](../../docs/design/angle-review.md)).
6. **Deterministic findings** (`@plex/deterministic`) on the changed lines, **minus any the user has waived** — `loadWaivers` + `isWaived` (identity-only, no embeddings) drop a rule waived repo-wide (`pattern-repo` on the rule tag) or a waived file/line, so a dismissed rule never even primes the agent. This is the SAME suppression `rankFindings` applies at submit time, pulled one step earlier (it used to surface here as "incorporate these" and only get dropped from the final stream).
7. **Knowledge retrieval** — query built from changed symbols + deterministic titles + files; with no embedding provider it falls back to lexical (IDF token-overlap) retrieval (degrades, never fails).
8. **Brain round** (`buildBrainContext`) — reads/writes the durable JSONL lineage layer (no Kùzu open, ADR-46): `loadRoundState` → ingest PR comments → if the head moved since the last round, attribute changes (semantic, embeddings-only) and run fix inference (`recordFixAccepts` — works locality-only without embeddings) → `recordRound`. **Embedding-cost guards (the Voyage bill):** the attribution batch only fires when there's a semantic gain to be had — `signals.length > 0` (classify against comments/prior signals) OR `priorFindings.length > 0` (semantic fix-match); with neither, the embed is skipped entirely (locality fix-match still runs, and "changed with no signal → unexplained" is marked without embeddings — it needs none). Prior-finding TITLES go through `cachedEmbed` (the `embed-cache.json` sidecar) so they're embedded once across all rounds, not re-embedded every round; per-round region/comment CONTENT is embedded fresh (it changes each round).
9. **Audit log** (`context_assembled`) and the returned `ReviewContext` with `notes` — the agent guidance (fresh eyes, severity/confidence as separate axes, never display confidence, reviewPlan directive, staleness warnings, embeddings-off nudge).

`priorRounds`, `openComments`, and `unexplainedChanges` are fed as **facts** (ADR-02) — never prior reasoning.

## The brain — the durable lineage layer (src/brain.ts, ADR-46)

The brain is **no longer Kùzu**. It's a **durable, base-keyed, append-only JSONL event log** — one file
per review target at `~/.plex/repos/<baseId>/lineage/<target>.jsonl` (via `lineagePaths`/`baseRepoPath`,
paths.ts). `Brain` keeps the same method surface (`open`/`close`/`loadRoundState`/`recordRound`/
`writeFindings`/`writeVerdict`/`markFindingOutcome`/`openTargets`/`rankingSamples`) so callers are
untouched, but internally it **appends events** and folds them with the pure **`foldLineage`**
(`@plex/core`, shared with the viz-server so both agree on the rules). `close()` is a no-op (no handle).
Event kinds + state:

- `round` → `Round(n, ts, headSha, baseRef)` (LWW by n).
- `finding` → id `target#file:startLine#normalizedTitle` (**round-free** so a re-raise is the SAME
  finding, ADR-28); a finding event updates every field **except outcome**.
- `outcome` → sets a finding's outcome (the ONLY writer of outcome — so a re-raised finding never
  resets a `fixed`/dispositioned outcome; this is the load-bearing fold rule, in `foldLineage`).
- `verdict` → keyed by `findingId` (LWW); `comment` → keyed by `target#commentId`.

A review now opens Kùzu **only for the code graph** (one open) — the brain is plain files. The log is
append-only but reads are idempotent (the fold is LWW per id), so a re-recorded round/finding collapses.

### The `reviewTargetFor` invariant (base-keyed)

**Every lineage write keys off `reviewTargetFor(repoPath, src)`** = `reviewTarget(basename(baseRepoPath(repoPath)), src)`
(`src/target.ts`) — round recording (`review.ts`), finding writes (`findings.ts`), verdicts
(`knowledge.ts` / MCP `record_outcome`), reconcile (`reconcile.ts`). It keys off the **BASE repo**
basename (the primary checkout a worktree branches from), **never** the worktree dir name or the code
graph's `repo` meta — so a review from a worktree and one from the base of the SAME PR resolve to ONE
target, stored under the base repo's data dir, surviving `git worktree remove`. (`verdicts.jsonl` is
base-keyed the same way.) Because the key is base-derived, the brain **cannot split across worktree
names** — so the old `Brain.healSplitTarget` guard + `HEAL_RELABEL_ORDER` are **deleted** (ADR-46);
do not reintroduce them.

## Reconcile (src/reconcile.ts)

A finding counts as *addressed* (→ auto-`accept` + `outcome: fixed`) when EITHER:
- **semantic**: cosine(finding-title embedding, changed-region embedding) ≥ `adaptiveFloor(0.6, batch background)` — adapts upward only on anisotropic models, never below 0.6; or
- **locality**: a change landed in the finding's own file within a line window (`findingAddressedAt`, `@plex/findings`) — needs **no embeddings**, and catches restructuring fixes (try/catch wrap, moved lines) whose diff reads nothing like the title.

`note` findings are never auto-accepted (ADR-31; only explicit `acknowledge`/`reject`). Every exit returns a `reason` so `accepted: 0` is diagnosable: no open findings / no prior round (the split-brain tell) / head unresolvable / head unchanged / nothing added / N files changed but none matched. When `accepted > 0`, **`acceptedFindings`** lists each auto-accepted finding with the signal that matched it (`semantic` | `locality`) — the audit trail that keeps locality accepts honest; the same list reaches the next review's context as **`inferredAccepts`** (the agent relays "N prior findings verified fixed" and can contest a wrong one). The same `recordFixAccepts` runs inline on the **next review** (step 8 above), so a standalone install closes the accept-loop with no responder (ADR-36).

**Learning idempotency.** A finding feeds the knowledge base at most once: `submitVerdict` skips `learnIncident` when an accept verdict for the same `findingId` is already logged, and projects every explicit verdict onto the brain `Finding.outcome` (accept→`accepted`, reject→`rejected`, waive→`waived`, acknowledge→`acknowledged`) so a dispositioned finding leaves `priorFindings` and can't be re-accepted by later fix inference.

## Invariants & gotchas

- **ADR-02**: nothing here ever feeds the reviewer prior reasoning — brain state, comments, and the audit log are facts/records only.
- **ADR-17/19**: ship built JS under node (`pnpm build` → `dist/`), never tsx. A review process = **1 graph open** (the brain is now JSONL, ADR-46 — no second open); anything more (index/refresh) goes through `indexIsolated`. The foreground review retries its graph open on a transient `RepoBusyError` (a detached sweep's re-index briefly holds the single-writer lock).
- **Embeddings are optional (ADR-30)** — degradation map: knowledge retrieval → lexical (keyword) fallback; semantic waivers → identity-only matching; change attribution (`unexplainedChanges`) → skipped; fix inference → locality-only. `safeEmbed` (`@plex/core`) also degrades transient embedding failures to the same paths instead of failing the review.
- **Best-effort everywhere on the bookkeeping edges**: audit logging, blast-map sidecar, PR auto-comment, and the `head.sha` stamp never throw out of a review.
- `recordVerdict` persists the waiver embedding to disk but **strips it from the returned value** (the MCP echo would waste tokens no consumer reads).
- The analysis write paths (`scanForAnalysis`, `addAnalyzedPitfalls`) **require** embeddings (`requireEmbeddings`) — clustering needs vectors. Knowledge is learned only; markdown seeding (`plex.md`) was retired (ADR-37).

## Testing

- **Units (vitest, `pnpm test:unit`)**: pure modules only — `audit`, `config-load`, `guards`, `paths`, `pr-comment`, `target`, `verdicts`, `viz` `.test.ts` files. Never open Kùzu in a `.test.ts` (crashes vitest teardown) — which is exactly why the silent-failure guards live in pure `guards.ts` (testable) rather than inline in `brain.ts`.
- **Integration (`pnpm test:integration`)**: `integration.mts`, run one scenario per tsx process (ADR-17 open limit; keep each scenario ≤2 Kùzu opens) — orchestrated by **`scripts/run-integration.mjs`**, which spawns each scenario in its own `tsx` process and **retries a transient Kùzu native crash** (exit 139 / `SIGSEGV`) the same way the node check scripts do (a real failure — any other non-zero exit — fails fast, never masked). Add a new scenario to the `SCENARIOS` list there. Scenarios cover build/incremental/co-change, neighborhood, ranking, knowledge, semantic waivers, reconcile, review-plan, brain (now the JSONL lineage store), worktree-seed.
- **Node-only E2Es** (the shipped runtime, need `pnpm build`): `pnpm test:brain` (`scripts/brain-check.mjs` — auto-index on first review, round-aware changed-without-feedback), `pnpm test:worktree` (`scripts/worktree-seed-check.mjs` — the isolated-child base refresh that tsx structurally *cannot* exercise), and `pnpm test:sweep` (`scripts/sweep-check.mjs` — the ADR-43 maintenance worker: refreshes main's graph, manages its sidecars + lock, idempotent; node-only because the worker opens Kùzu several times per run, over the tsx limit). The sweep's loop-closure path rides `reconcileOutcomes` (the `reconcile` integration scenario); its pure gates are unit-tested in `sweep.test.ts`.
