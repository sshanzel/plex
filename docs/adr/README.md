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
**Consequences.** Durable graph scales past RAM; ephemeral graph is cheap and inspectable in FalkorDB Browser. *Rejected:* memory-first for everything (RAM-bound at scale); Neo4j (JVM weight, GPLv3). FalkorDB optional — degrades to in-process.

## ADR-08 — Knowledge graph schema ✅
**Decision.** `Category → Pitfall{trigger, why, confidence, tier} → Mitigation`; `Pitfall ─EVIDENCED_BY→ Incident` (provenance); `Pitfall ─PROMOTED_TO→ Rule`; `Finding ─INSTANCE_OF→ Pitfall` + `─AT→ CodeLocation`; `Waiver ─SUPPRESSES→ Pitfall` (scoped).
**Consequences.** Makes the `signal` formula computable and every pitfall auditable.

## ADR-09 — Markdown ⇄ graph duality ✅
**Decision.** `plex.md` is both input (cold-start seed, overrides) and output (proposed promotions). Graph = learned engine; markdown = human steering wheel. Codifiable + high-confidence → Semgrep/ast-grep.
**Consequences.** Trust (humans read/edit a file, not a black box) + cold-start path.

## ADR-10 — Feedback loop: scoped verdicts + self-discovery ✅
**Decision.** Verdicts (accept/reject/waive) carry a **scope** (`line|file|pattern-repo|category-repo|category-global`) and reweight the graph. Confirmed novel bugs become `Incident`s → may distill into `Pitfall`s.
**Consequences.** The system learns from its own discoveries, not just mined history.

## ADR-11 — Mining is outcome-weighted, provenance-mandatory ✅ (deferred build)
**Decision.** Source unit = `(code-before → review comment → resolving diff)`. Cluster across repos; a cluster (not a singleton) distills into a pitfall; every pitfall links its incidents. *Build deferred (M4 out of scope for now).*

## ADR-12 — Language: TypeScript/Node ✅
**Decision.** Implement everything in TS/Node. Matches expertise (fastest), single runtime to ship, native TS compiler access. Python reserved only for heavy mining clustering if ever needed.

## ADR-13 — Embeddings: pluggable provider ✅
**Context.** Opus/Claude are *not* embedding models.
**Decision.** Abstract embeddings to `text → vector`. Default Voyage `voyage-code-3` or OpenAI `text-embedding-3-small` (cents); local Ollama option for private repos; a deterministic fake for tests. Vectors in Kùzu's vector index or a `sqlite-vec` sidecar.

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

## ADR-18 — Knowledge base is a JSON-backed embedded store (for now) ✅
**Context.** ADR-07 placed the knowledge graph in Kùzu, but the knowledge corpus is small, retrieval is embedding-based (not multi-hop graph traversal), and adding a second Kùzu DB to the hot path compounds the tsx open-limit (ADR-17).
**Decision.** Store pitfalls + incidents as append-only JSONL under `knowledgeDir` (global, `~/.plex/knowledge` by default), with embeddings stored on each pitfall and cosine retrieval in-process. The `Pitfall`/`Incident`/`Category` schema (ADR-08) is preserved as record shapes.
**Consequences.** Simple, fast, no native-DB coupling in the retrieval path; matches the plan's "let the graph earn its place." Graduate the knowledge side to Kùzu only if/when genuine multi-hop graph queries are needed.

## ADR-19 — Ship bundled JS run under node ✅
**Context.** tsx is unstable with the Kùzu addon (ADR-17); node is stable. The codebase uses extensionless (Bundler) imports node can't resolve directly.
**Decision.** `tsup` bundles the CLI and MCP server (workspace source bundled; native/heavy third-party deps external) to ESM in `dist/`, run via `pnpm start` / `pnpm start:mcp` under node. The FalkorDB child worker is copied beside the output; the external runtime deps are declared in the **root** package.json so they resolve from the root `node_modules`.
**Consequences.** Stable production runtime; dev still uses tsx for fast iteration (with the open-limit caveat). Source-of-truth for "how to ship."
