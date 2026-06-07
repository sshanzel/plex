# Decision Log (ADRs)

Each decision below was made deliberately during design or build. Format: **Context → Decision → Consequences / rejected alternatives**. New decisions append here as `ADR-NN`; a decision that grows large or gets superseded graduates to its own `NNNN-title.md` file.

Status legend: ✅ accepted · 🔁 superseded · 🧪 provisional

---

## ADR-01 — RAG, not fine-tuning ✅
**Context.** We want the reviewer to learn from accumulated review knowledge.
**Decision.** Knowledge is a curated, provenance-backed, *editable* corpus retrieved at review time — never baked into model weights.
**Consequences.** Inspectable, deletable, instantly updatable, local-first; no GPU/training loop. *Rejected:* fine-tuning — opaque, stale-fast, can't audit or surgically edit a single lesson.

## ADR-02 — Model-agnostic MCP server; two LLM contexts ✅
**Context.** Reviews must be unbiased and ride the user's existing agent subscription.
**Decision.** The reviewer is an MCP server. *Interactive review* uses whatever agent connects (fresh session = unbiased). *Offline batch* work (if any) makes its own API calls.
**Consequences.** No vendor lock-in; the server never needs an interactive-LLM key. The fresh process is the anti-bias mechanism.

## ADR-03 — Three finding sources, one ranked stream ✅
**Context.** Pattern-matching alone is a glorified linter; raw LLM alone is biased/inconsistent.
**Decision.** Merge **first-principles** (agent reasoning, the spine), **knowledge-grounded** (retrieved pitfalls), and **deterministic** (Semgrep/ast-grep) into a single stream.
**Consequences.** Catches novel *and* recurring issues; cross-source agreement becomes a confidence signal.

## ADR-04 — Severity and confidence are independent axes ✅
**Context.** "Potential bug" is a real category users care about.
**Decision.** `severity ∈ {bug, improvement, nit}` and `confidence ∈ [0,1]` are separate. A "potential bug" = `bug` + low confidence. Ranking: `signal = severity × confidence × deviation × blastRadius − waiver`.
**Consequences.** The reviewer states honest confidence instead of faking certainty.

## ADR-05 — Prevalence interpreted by severity ✅
**Context.** A pattern in 200 places shouldn't be nagged per-line — but a *bug* in 200 places is worse, not safer.
**Decision.** Common **style** → convention (demote). Common **bug** → systemic (escalate as a migration, with blast radius). Suppression never silences widespread real bugs.

## ADR-06 — Layered code understanding, unioned by provenance ✅
**Context.** Precise call-graph resolution is language-specific and expensive; blast radius only needs *coupling*.
**Decision.** Agnostic spine (git co-change + imports + embeddings) always on; precise edges (TS compiler) as optional enrichment. All edges carry `provenance` + `weight` and are unioned.
**Consequences.** Co-change catches runtime couplings (DI/injected services) that imports and static analysis miss; no single source is trusted alone.

## ADR-07 — Storage = Kùzu (durable) + FalkorDB (ephemeral); N+1 topology ✅
**Context.** Local-first, open-source, possibly many repos; want live graph debugging.
**Decision.** Kùzu (embedded, MIT, disk-backed) holds N per-repo code graphs + 1 global knowledge graph, joined at `Finding`s. FalkorDB (in-memory, multi-graph) holds ephemeral per-PR `pr_<id>` neighborhoods.
**Consequences.** Durable graph scales past RAM; ephemeral graph is cheap and inspectable in FalkorDB Browser. *Rejected:* memory-first for everything (RAM-bound at scale); Neo4j (JVM weight, GPLv3). ~~FalkorDB optional — degrades to in-process.~~ **Amended by ADR-22 (M6):** FalkorDB is now a *required* working-memory store for the review flow (AOF-persisted), no longer optional.

## ADR-08 — Knowledge graph schema ✅
**Decision.** `Category → Pitfall{trigger, why, confidence, tier} → Mitigation`; `Pitfall ─EVIDENCED_BY→ Incident` (provenance); `Pitfall ─PROMOTED_TO→ Rule`; `Finding ─INSTANCE_OF→ Pitfall` + `─AT→ CodeLocation`; `Waiver ─SUPPRESSES→ Pitfall` (scoped).
**Consequences.** Makes the `signal` formula computable and every pitfall auditable.

## ADR-09 — Markdown ⇄ graph duality ✅
**Decision.** `plex.md` is both input (cold-start seed, overrides) and output (proposed promotions). Graph = learned engine; markdown = human steering wheel. Codifiable + high-confidence → Semgrep/ast-grep.
**Consequences.** Trust (humans read/edit a file, not a black box) + cold-start path.

## ADR-10 — Feedback loop: scoped verdicts + self-discovery ✅
**Decision.** Verdicts (accept/reject/waive) carry a **scope** (`line|file|pattern-repo|category-repo|category-global`) and reweight the graph. Confirmed novel bugs become `Incident`s → may distill into `Pitfall`s.
**Consequences.** The system learns from its own discoveries, not just mined history.

## ADR-11 — Mining is outcome-weighted, provenance-mandatory ✅ (built, M4)
**Decision.** Source unit = `(code-before → review comment → outcome)`. Cluster across PRs; a cluster (not a singleton) distills into a pitfall; every substantive comment becomes an `Incident` and pitfalls keep their `incidentIds`. Outcome is pragmatic (merged PR ⇒ accepted/shipped); incremental per-repo cursor skips already-scanned PRs.

## ADR-12 — Language: TypeScript/Node ✅
**Decision.** Implement everything in TS/Node. Matches expertise (fastest), single runtime to ship, native TS compiler access. Python reserved only for heavy mining clustering if ever needed.

## ADR-13 — Embeddings: pluggable provider; real-or-nothing ✅
**Context.** Opus/Claude are *not* embedding models. Embeddings power knowledge retrieval AND mining clustering.
**Decision.** Abstract embeddings to `text → vector`. Providers: Voyage `voyage-code-3` (code-specialized, Anthropic-recommended), OpenAI `text-embedding-3-small`, Google `gemini-embedding-001`, local Ollama `nomic-embed-text`. **No fake/heuristic embeddings in real operation** — the default is `none`; the deterministic `fake` embedder is test-only. Retrieval degrades gracefully without a provider (returns nothing); write paths (seed/mine) error.
**Consequences.** Knowledge features require an explicit real provider (no silent noise — fake embeddings don't discriminate, so they pollute retrieval). Switching providers requires re-embedding (vectors aren't cross-comparable). Updated after observing fake embeddings retrieve every pitfall for any query. **M6 (ADR-22/23):** the PR brain's change attribution is embedding-based (semantic, no line/title heuristic), so embeddings are **required** for the review brain — when FalkorDB is enabled the review errors without a provider, exactly as the knowledge write paths do. (The deterministic `fake` embedder remains test-only.)

## ADR-14 — All inputs normalize to "diff vs base ref" ✅
**Decision.** Local (working/staged/branch) and GitHub PR (`gh pr diff`) inputs both reduce to one `NormalizedDiff`. PR-vs-local is not a meaningful internal distinction; `gh` is just an adapter.

## ADR-15 — v1 TS plugin uses the TypeScript compiler API, not tree-sitter ✅
**Context.** The plan named tree-sitter for the structural layer. For a TS/JS-first v1, the TS compiler API is more accurate (real symbol/import/reference resolution), needs no native build, and serves *both* structural (M1) and precise (M2) edges.
**Decision.** v1 language plugin = TS compiler API. The agnostic co-change spine stays parser-free (pure git). tree-sitter remains the documented extension path for *other* languages behind the same extractor interface.
**Consequences.** Lower dependency risk, better TS accuracy; multi-language breadth deferred to when non-TS plugins are added.

## ADR-16 — FalkorDB publishing runs in an isolated child process ✅
**Context.** The Kùzu native addon and the FalkorDB/node-redis stack **SIGSEGV when used in the same process** (verified: exit 139 even after closing Kùzu first — loading the addon poisons the process). The MCP server needs Kùzu always and FalkorDB optionally.
**Decision.** Publish neighborhoods to FalkorDB from a separate child process (`packages/neighborhood/src/falkor-worker.mjs`, plain JS, no Kùzu). The parent spawns it, pipes the job over stdin, reads a JSON result, and treats any failure as "not published."
**Consequences.** The optional viz layer can never crash the server; FalkorDB stays decoupled. Keep `falkor-worker.mjs` out of the typecheck/test globs (it's plain JS) and copy it alongside built output when packaging.

## ADR-17 — Kùzu-heavy tests run via tsx, one process per scenario ✅
**Context.** The Kùzu addon does not survive **tsx**'s runtime loader after ~5 cumulative `Database` opens in one process (SIGSEGV), and it also crashes **vitest** worker teardown (ERR_IPC_CHANNEL_CLOSED) — though tests themselves pass. Under plain `node`, 12+ open/close cycles are stable; the product (built to JS, run under node) is unaffected.
**Decision.** vitest holds **pure unit tests only**. DB-/subprocess-heavy scenarios live in `packages/engine/integration.mts` and run via `pnpm test:integration`, which invokes tsx **once per scenario** (≤2 opens each, well under the limit). `pnpm test` runs both.
**Consequences.** Deterministic green suite. Must-remember: do not pile multiple Kùzu-opening operations into one long-lived tsx process; in production reuse a Database per dir and run built JS under node.
**M6 addendum.** A process that has loaded the Kùzu addon **and** spawns the FalkorDB worker (ADR-16) SIGSEGVs on teardown **under tsx** — i.e. the PR-brain review flow (Kùzu blast radius + FalkorDB brain) cannot run in the tsx integration runner. It is stable under plain **node** (verified end-to-end). So the brain's E2E check drives the *built CLI* under node — `scripts/brain-check.mjs` / `pnpm test:brain` (skips if FalkorDB is down) — while the pure `classifyChanges` decision is covered by a vitest unit test. The long-lived MCP server (node, never exits) is unaffected.

## ADR-18 — Knowledge base is a JSON-backed embedded store (for now) ✅
**Context.** ADR-07 placed the knowledge graph in Kùzu, but the knowledge corpus is small, retrieval is embedding-based (not multi-hop graph traversal), and adding a second Kùzu DB to the hot path compounds the tsx open-limit (ADR-17).
**Decision.** Store pitfalls + incidents as append-only JSONL under `knowledgeDir` (global, `~/.plex/knowledge` by default), with embeddings stored on each pitfall and cosine retrieval in-process. The `Pitfall`/`Incident`/`Category` schema (ADR-08) is preserved as record shapes.
**Consequences.** Simple, fast, no native-DB coupling in the retrieval path; matches the plan's "let the graph earn its place." Graduate the knowledge side to Kùzu only if/when genuine multi-hop graph queries are needed.

## ADR-19 — Ship bundled JS run under node ✅
**Context.** tsx is unstable with the Kùzu addon (ADR-17); node is stable. The codebase uses extensionless (Bundler) imports node can't resolve directly.
**Decision.** `tsup` bundles the CLI and MCP server (workspace source bundled; native/heavy third-party deps external) to ESM in `dist/`, run via `pnpm start` / `pnpm start:mcp` under node. The FalkorDB child worker is copied beside the output; the external runtime deps are declared in the **root** package.json so they resolve from the root `node_modules`.
**Consequences.** Stable production runtime; dev still uses tsx for fast iteration (with the open-limit caveat). Source-of-truth for "how to ship."

## ADR-20 — Mining distillation is agent-driven over MCP ✅
**Context.** Distillation needs generative reasoning. Doing it with a hardcoded API key (ADR-02 "offline batch") doesn't ride the user's Claude/Codex subscription, which is the whole cost motivation.
**Decision.** Split mining: the MCP server does the mechanical scan (`mine_scan` — fetch new PRs, denoise, record incidents, cluster) and returns clusters; the **connected agent distills them with its own reasoning** and stores results via `add_pitfalls`. The standalone path (`plex mine` / `mine_history`) also distills with an LLM — **by default the local `claude` CLI** (subscription, no key), or `anthropic`/`openai` via key. **There is no heuristic distiller** — a keyword heuristic can't judge whether a cluster is a real, generalizable lesson, so the LLM decides (it can SKIP a cluster). If no LLM is available, mining **errors** rather than storing low-quality pitfalls.
**Consequences.** Distillation is always intelligent; mining rides the subscription, mirroring the review loop. On-demand, not background — fine because the incremental cursor makes repeat runs cheap. Fits the user's PR-skill ecosystem (the **responder** skill's resolving diffs are the ideal future outcome signal).

## ADR-21 — Knowledge has scope: global vs repo ✅
**Context.** Mining (and the agent) surface lessons that are specific to one project. Discarding them loses value *for that project*; storing them globally pollutes others.
**Decision.** Each `Pitfall` carries a `scope`: `global` (applies everywhere) or `repo` (stored, but only retrieved when reviewing its origin `repo`). Undefined = global (back-compat). The LLM classifies scope during distillation; seeded `plex.md` pitfalls are global; mined/agent pitfalls default to `repo`. Retrieval filters: `scope === global || pitfall.repo === currentRepo`.
**Consequences.** Project-specific knowledge helps within its project without leaking elsewhere; global best-practices apply everywhere. The reviewer accumulates both kinds.

## ADR-22 — FalkorDB is the per-PR working memory, and is REQUIRED ✅ (built, M6)
**Context.** ADR-07 scoped FalkorDB to an *ephemeral visual mirror* of the structural blast radius. In practice the blast radius is computed entirely from **Kùzu + the diff**; FalkorDB only received a copy to look at — a graph you only look at "produces nothing." Maintaining a second in-process code path purely so FalkorDB stays optional is an unnecessary optimization; the durable, queryable *history* of what happened on a PR is the real value.
**Decision.** Promote the per-PR FalkorDB graph from *optional viz mirror* to a **required component** of the review flow — the persistent "brain of the PR." Beyond the blast radius it holds `Round`, `Finding`, `Verdict`, and `Comment` nodes with their edges, and the orchestrator **reads and writes** it to derive round-aware signals (§ADR-23). The in-process fallback is **dropped**: if FalkorDB is unreachable, the review errors with a clear "run `pnpm db:up`" message rather than silently degrading. **FalkorDB persistence (AOF) is enabled** so the brain survives container restarts — that is what makes "history written down" real (Redis/Falkor is in-memory by default; without AOF a restart wipes it).
- **Sources of truth:** waivers stay in `<repo>/.plex/verdicts.json` (they apply across targets, independent of any one PR graph) and are *projected* into the brain; the PR brain (rounds/findings/comments) lives in FalkorDB (AOF-persisted).
- **Isolation unchanged (ADR-16):** the Kùzu addon and FalkorDB still cannot share a process, so *all* FalkorDB access — now reads as well as writes — goes through the isolated child worker, which becomes a small request/response RPC (`publish` | `query`).
**Consequences.** FalkorDB earns its place via cross-round / cross-blast-radius traversal queries that are awkward in flat JSON, and the PR history is inspectable live. Cost: FalkorDB (`pnpm db:up`) is now a hard prerequisite for reviewing, and the worker grows a read path. **Supersedes ADR-07's "FalkorDB optional / degrades to in-process" clause** for the review flow (Kùzu remains the durable code-graph store; the knowledge store remains JSON per ADR-18).

## ADR-23 — Round-aware review; "changed-without-feedback" ✅ (built, M6)
**Context.** Each review today is stateless across rounds. But a multi-round PR carries signal in the *deltas*: a change made in response to a review comment is low-risk; a change nobody asked for — slipped in between rounds — is exactly what a tiring human reviewer misses.
**Decision.** A review **target has rounds**: a round = a review invocation at a distinct head SHA, persisted in the brain (ADR-22). On a new round the orchestrator diffs round *N* vs *N−1* and classifies each changed region by **embedding similarity** (NOT line proximity — no heuristic; ADR-13): **feedback-driven** if its content is semantically close to a prior finding or PR-thread comment, else **unexplained** (changed with nothing driving it) — surfacing the *unexplained* set as a high-priority note to the fresh reviewer ("these moved with nothing explaining why — scrutinize"). PR-thread comments are ingested per round (reusing the mining fetcher) as **facts**. Implemented: `engine/brain.ts` (rounds), `findings/rounds.ts` (the pure `classifyChanges` cosine decision), `ingest` head-SHA + inter-round-diff helpers.
**Consequences.** Multi-round reviews get sharper without re-biasing — this stays squarely inside ADR-02: only **facts** cross rounds (verdicts, comments, what changed), never the prior run's chain-of-thought. Requires head SHAs (available for PR/branch; working-tree falls back to `HEAD`). Brand-new files added by a PR have no graph node until re-index — that blind spot is unchanged and explicitly noted to the agent.

## ADR-24 — Review audit log for attribution & self-improvement ✅ (built, M6)
**Context.** We can't improve what we don't measure. Today a review leaves only `verdicts.json`; the *context that produced* each finding — which blast-radius files were in view, which pitfalls were retrieved, whether change-context was present — evaporates. We also can't answer "did the graph/knowledge actually help?" (the very question that came up confirming the analytics finding).
**Decision.** Emit an **append-only JSONL audit log** of the review lifecycle to `<repo>/.plex/log/events.jsonl`, one event per step, each tagged with a correlation key `{repo, target, round, ts}`:
- `context_assembled` — diff summary, blast-radius node ids + scores + provenance, retrieved pitfall ids + scores, `changeContext` presence;
- `findings_submitted` — per finding: source, severity, confidence, computed signal, location, triage;
- `outcome_recorded` — verdict kind + scope.
The flat log is greppable and graph-independent; the FalkorDB brain (ADR-22) is its *queryable projection*.
**Limitation (honest scope).** The server logs what it **provided** and what the agent **submitted** — not the agent's private reasoning. Attribution is therefore *correlational* ("finding X was submitted with pitfalls A,B and coupled files C,D in context"), which is enough to tune retrieval/weights, debug context assembly, and answer "what did the reviewer see." It deliberately does **not** capture chain-of-thought (ADR-02).
**Consequences.** Real-outcome tuning of retrieval and `signal` weights becomes possible; "why did this surface?" is answerable after the fact; provenance, not opinion, is what's stored.

## ADR-25 — Incremental indexing + graph staleness ✅ (built, M7)
**Context.** The full code-graph build re-parses *every* file with the TS compiler — the dominant cost, and real on large monorepos (playright). After a pull/merge the graph drifts: edges for edited files go stale and **brand-new files have no node at all** until a manual reindex, silently shrinking the blast radius. The graph already stamps `headSha` at index time (`build.ts`), but nothing reads it back. Crucially, the full graph is *worth* building once — PR-level work only **reads** it, and blast radius is meaningless without the whole repo's couplings (you expand *into* files the diff didn't touch). So the answer is "build once, refresh cheaply," not "index per-PR."
**Decision.** Three parts:
- **Staleness signal + auto-refresh.** On review, compare the graph's stored `headSha` to current `HEAD`. If it has drifted (`behind > 0`), **auto-refresh the graph incrementally before computing the blast radius** so the neighborhood is never silently stale (opt out with `autoIndex:false`); the review notes it did so (`↻`). An unknown/missing index (`behind = -1`) is only *reported*, not auto-refreshed — refreshing it would mean a surprise full rebuild mid-review.
- **Incremental indexing.** Given files changed since the stored `headSha` (`git diff --name-status <sha> HEAD`): re-extract only **added/modified** files and drop **deleted** ones — *preserving incoming edges of modified files* (delete only their Symbols + outgoing Imports/Refs, keep the File node) — then re-stamp `headSha`. Refresh becomes O(changed files). Full rebuild stays available (`--fresh`). **Co-change is recomputed fully** (not incrementally merged) in v1: its recency-decayed weights are relative to "now", so merging deltas is subtle, and the git-log crawl is the cheap half anyway (no TS parse). TS-symbol/import/precise-ref re-extraction — the expensive half — is what goes incremental.
- **Git hooks.** `plex install-hooks` writes `post-merge` / `post-checkout` / `post-rewrite` → `plex index --incremental`, so the graph self-refreshes on pull/checkout/rebase.
**Consequences.** Pay the big parse cost once; keep fresh in O(changed files); the blast radius stops silently drifting and new files stop being invisible. Workspace/runtime couplings that static resolution misses remain covered by co-change (ADR-06). Incremental indexing is Kùzu-only (no FalkorDB), so it is safely covered by the tsx integration runner (ADR-16/17). ~~*Deferred:* truly incremental co-change.~~ **Done in ADR-26.**

## ADR-26 — Truly incremental co-change ✅ (built, M8)
**Context.** ADR-25's incremental index still recomputed co-change **fully** (re-crawl all `maxCommits` of history) — the cheap half, but not actually incremental. The blocker was recency decay: weights are relative to "now", so naively merging deltas drifts.
**Decision.** On an incremental update, crawl only `storedSha..HEAD` (the new commits) and **merge** their contributions onto the stored pairs. Two observations make this exact without epoch bookkeeping: (1) `aggregateCoChange` clamps age with `Math.max(0, now−ts)`, so the just-landed commits contribute at **full recency** regardless of the reference; (2) decay **re-baselines on every full build**, and incremental only *adds* recent evidence. Pruning is preserved: increment pairs reaching `minPairCount` within the window **create-or-accumulate** (`MERGE … ON CREATE/ON MATCH`); sub-threshold pairs **only accumulate into already-stored pairs** (`MATCH … SET`), never creating singletons — so the ADR-06 N² denoising stands.
**Consequences.** Incremental index now skips *both* the TS re-parse (ADR-25) and the full git-history crawl — co-change refresh is O(new commits). The one residual imprecision: a pair below threshold in *every* window stays pruned until a full rebuild (by design; self-heals on `plex index` without `--incremental`). Old pairs keep their last-full-build decay (not re-decayed each increment), which is the intended "recency relative to the last full index" model.

## ADR-27 — Semantic waiver suppression ✅ (built, M8)
**Context.** Waivers matched by **exact identity** (file+line, or normalized-title equality). Line-scope breaks the moment code moves; pattern-scope breaks when the finding is reworded — so "I said ignore this issue" resurfaces a round later, the exact gap raised when designing the brain. M6 made change-attribution embedding-based; waivers should use the same signal.
**Decision.** A pattern/category-scoped waiver also stores an **embedding** of the waived finding (title + note). At rank time, findings are embedded and a waiver matches **semantically** when cosine ≥ `0.82` — *complementing*, not replacing, identity matching. Precise scopes (`line`/`file`) stay exact (they're locational on purpose). Best-effort and back-compatible: it needs a provider (already required in the M6 review flow) and the default threshold (1.01) disables semantic matching so the pure matcher is unchanged when no embeddings are supplied. Stays within ADR-02 — a waiver is a *fact* (the user's verdict), not replayed reasoning.
**Consequences.** A waived issue stays waived across rounds despite line drift and rewording; the long-standing "I said ignore it" leak is closed. The match is in the pure `waiverMatches` (vectors in — unit-tested); the engine embeds findings + waive-time titles at the boundary. Requires embeddings (already mandatory for the brain — ADR-13/22).

## ADR-28 — Autonomous review; outcomes inferred from response, not prompted ✅ (built, M9)
**Context.** The review loop asked the user to accept/reject/waive each finding — an interactive gate that breaks flow and (worse) re-introduces bias by quizzing the user mid-review. The right model is the one the PR-responder ecosystem already implies: review **autonomously**, then learn from the user's *actual response* (did they fix it? did they push back?).
**Decision.** The reviewer **submits findings and stops** — it never prompts for a verdict. Outcomes are recorded autonomously from **explicit signals only** (the user's chosen policy — silence is not a signal):
- **Fix → `accept`, automatic.** On the next round, a prior-round finding whose content is addressed by a change-since (embedding cosine ≥ `0.6` between the finding and a since-change region, in the brain) is auto-recorded as `accept`/fixed and marked `outcome=fixed` so it's evaluated once. This rides the *existing* `get_review_context` call — re-reviewing a PR after pushing fixes closes the loop; no extra step.
- **Dismissal → `reject`, agent-driven.** An explicit "intentional / won't-fix" stays the agent/responder's call via `record_outcome` (intelligent classification, ADR-20 spirit — no engine keyword heuristic).
- **Silence → nothing.** A finding the author simply hasn't reached is never inferred as a reject.
Auto-accepts feed the existing `consolidate_knowledge` reweighting.
**Consequences.** Reviews never interrupt to ask; the feedback loop runs off real behavior; no false negatives from silence or brittle keyword-guessing. The decision (`findingAddressed`) is pure + unit-tested; the brain stores findings per round (M6) and marks their inferred outcome. Requires the brain + embeddings (already mandatory — ADR-13/22). E2E-verified under node (`pnpm test:brain`: inject a finding → address it with a commit → next review auto-accepts and marks it fixed).
**On-demand `reconcile`.** The same fix-inference is exposed as a standalone, **Kùzu-free** primitive (`reconcileOutcomes` / MCP `reconcile_outcomes` / `plex reconcile`): check a target's open findings against what's been pushed since and record the accepts, *without* a full review. This is the right home for "check after a push" — call it from the responder skill (on PR-thread resolution it can also just `record_outcome accept` directly) or a CI `on: push` step. Deliberately **not** a `pre-push` git hook: that would run FalkorDB + embedding calls on every push and could block/fail it (keep git hooks to the cheap Kùzu incremental index — ADR-25).
