# @plex/engine

The orchestration layer behind every MCP tool and CLI command. The MCP server (`@plex/mcp-server`)
and CLI (`@plex/cli`) are thin surfaces over this package: it composes ingest + code-graph +
neighborhood + deterministic + findings + knowledge + review-history analysis into the actual review flow, and owns
the PR brain. Read the root `AGENTS.md` first; decisions live in [`docs/adr/README.md`](../../docs/adr/README.md).

## Module map

**Config & paths**
- `src/config-load.ts` — `loadConfig()`: defaults < `~/.plex/config.json` < `PLEX_*` env < explicit overrides (precedence verified in that order in code).
- `src/home-config.ts` — read/merge-write `~/.plex/config.json` (chmod 600; holds the embedding API key).
- `src/paths.ts` — `repoPaths()`: where a repo's data lives (`~/.plex/repos/<id>` by default: `graph.kuzu`, `brain.kuzu`, `verdicts.jsonl`, `analyze-state.json`, `log/events.jsonl`, `head.sha`); `ensureDataDir()` makes an in-repo data dir self-ignoring.

**Diff & identity**
- `src/diff.ts` — `DiffSource` (`source: local|pr`, `mode: working|staged|branch`, `baseRef`, `pr`) → `NormalizedDiff` via `@plex/ingest`.
- `src/change-context.ts` — the author's *stated intent* (PR title/body, or commit subjects for branch mode) as a fact to check the code against.
- `src/target.ts` — `reviewTarget` / `reviewTargetFor`: the brain's correlation key (see invariant below).

**Review context & indexing**
- `src/review.ts` — `indexRepo` (full/incremental/worktree-seeded, ADR-32), `assembleReviewContext` (the heart — see below), `blastRadius`.
- `src/viz.ts` — `reviewContextToHtml`: self-contained Cytoscape HTML of the neighborhood (`plex review --html`).

**PR brain & reconcile**
- `src/brain.ts` — the embedded Kùzu brain (ADR-30): schema, round state, finding/verdict writes, `healSplitTarget`, `rankingSamples`.
- `src/reconcile.ts` — `reconcileOutcomes` (standalone "did the author fix these?") + `recordFixAccepts` (shared with the in-review fix inference, ADR-28).

**Findings & verdicts**
- `src/findings.ts` — `getDeterministicFindings`; `rankReviewFindings`: merge agent + deterministic findings, blast enrichment from the sidecar, semantic waivers (ADR-27), rank, persist to brain, optional PR auto-comment.
- `src/pr-comment.ts` — pure `buildReviewPayload` (dedup vs prior rounds, inline vs summary) + best-effort `postFindingsToPr` (ADR-34).
- `src/verdicts.ts` — append-only `verdicts.jsonl`; `loadWaivers` turns `waive`/`acknowledge`/`reject` verdicts into suppression rules.
- `src/knowledge.ts` — knowledge store wiring (retrieval, seed, consolidate, promotions) + `submitVerdict` (verdict → JSONL + incident-on-accept + brain projection + audit). An accept without an explicit `pattern` runs `inferPitfallId` (embedding cosine ≥ `adaptiveFloor(0.7, …)`, lexical ≥ 0.45 for vectorless/key-less; conservative — no match beats a wrong match) so first-principles accepts reinforce pitfalls too.

**Analysis, eval, audit**
- `src/analyze.ts` — incremental PR-review-history scan cursor; `analyzeRepo` (standalone LLM distillation), `scanForAnalysis`/`addAnalyzedPitfalls` (agent-driven path). Uses the `@plex/distill` package as the clustering/distillation technique.
- `src/ranking-eval.ts` — `rankingQuality`: offline nDCG of `signal` vs outcomes; measurement only ([`docs/design/tuning.md`](../../docs/design/tuning.md)).
- `src/audit.ts` — ADR-24 append-only audit log: what was PROVIDED and SUBMITTED, never chain-of-thought (ADR-02).

## The review-context assembly (`assembleReviewContext`, src/review.ts)

Order matters; each step feeds the next:

1. **Diff + stated intent** in parallel (`resolveDiff`, `resolveChangeContext`).
2. **Auto-index on first use** — no graph → `indexIsolated()` spawns `node dist/plex.js index` as a child. Isolation is the ADR-17 constraint: tsx (and to a lesser degree any single process) tolerates only a few Kùzu `Database` opens, and a review already needs **one open for the neighborhood + one for the brain**; indexing in-process would be a third. In dev/tsx `indexIsolated` no-ops (no built CLI beside `argv[1]`).
3. **Staleness check + drift refresh (ADR-25/36)** — read the sidecar `head.sha` (no Kùzu open), and if HEAD is definitively ahead, refresh incrementally in the same isolated-child way. The review is the *only* refresh trigger (no git hooks, ADR-36). Committed deletions: `indexRepo` captures a deleted file's direct dependents into the **`deleted-neighbors.json` sidecar** (`captureDeletedNeighbors`, one short extra open) BEFORE the update DETACH-DELETEs its node, and the review merges sidecar entries for the diff's deleted files after the walk — on ANY round, not just the one that triggered the refresh (dogfood round-1 caught the erased radius; round-2 caught that the first fix only covered the refresh-coinciding round).
4. **One code-graph open** — repo meta, `computeNeighborhood` (blast radius), coupling *among* changed files (for the review plan), coupling degrees; then close. A `blast-map.json` sidecar is written here so `submit_findings` can enrich per-finding `blastRadius` later **without another Kùzu open**.
5. **Review plan** — `reviewPlan()` (pure, `@plex/findings`) decides single vs parallel fan-out from the coupling graph ([`docs/design/parallel-review.md`](../../docs/design/parallel-review.md)).
6. **Deterministic findings** (`@plex/deterministic`) on the changed lines.
7. **Knowledge retrieval** — query built from changed symbols + deterministic titles + files; with no embedding provider it falls back to lexical (IDF token-overlap) retrieval (degrades, never fails).
8. **Brain round** (`buildBrainContext`) — second and last Kùzu open: `healSplitTarget` → `loadRoundState` → ingest PR comments → if the head moved since the last round, attribute changes (semantic, embeddings-only) and run fix inference (`recordFixAccepts` — works locality-only without embeddings) → `recordRound`.
9. **Audit log** (`context_assembled`) and the returned `ReviewContext` with `notes` — the agent guidance (fresh eyes, severity/confidence as separate axes, never display confidence, reviewPlan directive, staleness warnings, embeddings-off nudge).

`priorRounds`, `openComments`, and `unexplainedChanges` are fed as **facts** (ADR-02) — never prior reasoning.

## The brain (src/brain.ts)

Four node tables in `<repo-data>/brain.kuzu`, all keyed by `target`:

- `Round(id=target#n, target, n, ts, headSha, baseRef)`
- `Finding(id=target#file:startLine#normalizedTitle, target, title, severity, confidence, signal, source, file, line, triage, outcome, round, blast, prevalence, agreement)` — id is **round-free** so a re-raised finding is the SAME node (ADR-28 fix: round-keyed ids caused duplicate auto-accepts and orphaned signals); `ON MATCH` never resets `outcome`.
- `Verdict(id=target#findingId, target, findingId, kind, scope, ts, title, file, line)`
- `Comment(id=target#commentId, target, body, author, file, line)`

`Brain.open` is idempotent (DDL + swallow-on-exists `ALTER TABLE ADD` migration for the ranking-feature columns). One handle per review, reused for all brain I/O; always `close()`.

### The `reviewTargetFor` invariant

**Every brain write keys off `reviewTargetFor(repoPath, src)`** = `reviewTarget(basename(resolve(repoPath)), src)` (`src/target.ts`) — round recording (`review.ts`), finding writes (`findings.ts`), verdicts (`knowledge.ts` / MCP `record_outcome`), reconcile (`reconcile.ts`). **Never the code graph's `repo` meta**: a worktree seeds its graph by *copying* the base repo's graph (ADR-32), so the copy carries the BASE repo name while the worktree dir is named differently. Keying rounds off graph meta and findings off basename split the brain across two targets — reconcile found the findings but no `lastHeadSha` and reported `checked: N, accepted: 0`. Route any **new** brain key through `reviewTargetFor`.

`Brain.healSplitTarget(target)` is the belt-and-suspenders **permanent invariant guard** (not a one-off migration — do not delete): on every review and reconcile it checks the split signature (canonical target has findings but no rounds of its own) and, if found, adopts the same-suffix sibling target's rounds/comments/findings/verdicts. A healthy brain pays one COUNT.

## Reconcile (src/reconcile.ts)

A finding counts as *addressed* (→ auto-`accept` + `outcome: fixed`) when EITHER:
- **semantic**: cosine(finding-title embedding, changed-region embedding) ≥ `adaptiveFloor(0.6, batch background)` — adapts upward only on anisotropic models, never below 0.6; or
- **locality**: a change landed in the finding's own file within a line window (`findingAddressedAt`, `@plex/findings`) — needs **no embeddings**, and catches restructuring fixes (try/catch wrap, moved lines) whose diff reads nothing like the title.

`awareness` findings are never auto-accepted (ADR-31; only explicit `acknowledge`/`reject`). Every exit returns a `reason` so `accepted: 0` is diagnosable: no open findings / no prior round (the split-brain tell) / head unresolvable / head unchanged / nothing added / N files changed but none matched. When `accepted > 0`, **`acceptedFindings`** lists each auto-accepted finding with the signal that matched it (`semantic` | `locality`) — the audit trail that keeps locality accepts honest; the same list reaches the next review's context as **`inferredAccepts`** (the agent relays "N prior findings verified fixed" and can contest a wrong one). The same `recordFixAccepts` runs inline on the **next review** (step 8 above), so a standalone install closes the accept-loop with no responder (ADR-36).

**Learning idempotency.** A finding feeds the knowledge base at most once: `submitVerdict` skips `learnIncident` when an accept verdict for the same `findingId` is already logged, and projects every explicit verdict onto the brain `Finding.outcome` (accept→`accepted`, reject→`rejected`, waive→`waived`, acknowledge→`acknowledged`) so a dispositioned finding leaves `priorFindings` and can't be re-accepted by later fix inference.

## Invariants & gotchas

- **ADR-02**: nothing here ever feeds the reviewer prior reasoning — brain state, comments, and the audit log are facts/records only.
- **ADR-17/19**: ship built JS under node (`pnpm build` → `dist/`), never tsx. A review process = 1 graph open + 1 brain open; anything more (index/refresh) goes through `indexIsolated`.
- **Embeddings are optional (ADR-30)** — degradation map: knowledge retrieval → lexical (keyword) fallback; semantic waivers → identity-only matching; change attribution (`unexplainedChanges`) → skipped; fix inference → locality-only. `safeEmbed` (`@plex/core`) also degrades transient embedding failures to the same paths instead of failing the review.
- **Best-effort everywhere on the bookkeeping edges**: audit logging, blast-map sidecar, PR auto-comment, and the `head.sha` stamp never throw out of a review.
- `recordVerdict` persists the waiver embedding to disk but **strips it from the returned value** (the MCP echo would waste tokens no consumer reads).
- The analysis write paths (`analyzeRepo`, `scanForAnalysis`, `addAnalyzedPitfalls`) **require** embeddings (`requireEmbeddings`) — clustering needs vectors. Knowledge is learned only; markdown seeding (`plex.md`) was retired (ADR-37).

## Testing

- **Units (vitest, `pnpm test:unit`)**: pure modules only — `audit`, `config-load`, `paths`, `pr-comment`, `target`, `verdicts`, `viz` `.test.ts` files. Never open Kùzu in a `.test.ts` (crashes vitest teardown).
- **Integration (`pnpm test:integration`)**: `integration.mts`, run one scenario per tsx process (ADR-17 open limit; keep each scenario ≤2 Kùzu opens). Scenarios cover build/incremental/co-change, neighborhood, ranking, knowledge, semantic waivers, reconcile, review-plan, brain, brain-heal, worktree-seed.
- **Node-only E2Es** (the shipped runtime, need `pnpm build`): `pnpm test:brain` (`scripts/brain-check.mjs` — auto-index on first review, round-aware changed-without-feedback) and `pnpm test:worktree` (`scripts/worktree-seed-check.mjs` — the isolated-child base refresh that tsx structurally *cannot* exercise, since `indexIsolated` no-ops without a built CLI).
