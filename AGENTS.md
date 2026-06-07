# AGENTS.md

Guide for humans and coding agents continuing work on **reviewer**. Read this first, then [`docs/architecture.md`](docs/architecture.md) and the decision log [`docs/adr/README.md`](docs/adr/README.md).

## What this is (in one breath)

`reviewer` is a **local-first, open-source code reviewer**. It is *not* a new LLM — it's an **MCP server + orchestration layer** that any coding agent (Claude Code, Codex) connects to. It makes that agent rigorous and *unbiased* by running review in a fresh process, grounding it in a **blast-radius map** (Kùzu code graph) and **accumulated review knowledge** (knowledge graph), and merging first-principles + knowledge-grounded + deterministic findings into one ranked stream that learns from the user's verdicts.

## Repo layout

```
packages/
  core/          shared types, config, provider interfaces (no deps)
  ingest/        diff adapters: local git + gh PR → NormalizedDiff
  code-graph/    Kùzu per-repo graph: TS symbols/imports + git co-change   [M1]
  neighborhood/  diff→symbols→blast radius; optional FalkorDB ephemeral graph [M1]
  findings/      merge / dedup / rank / triage                            [M2]
  deterministic/ Semgrep / ast-grep runner                                [M2]
  knowledge/     knowledge graph + retrieval + plex.md                [M3]
  mcp-server/    MCP tool surface + orchestration
  cli/           `reviewer index | review`                                [M1]
docs/
  architecture.md         living architecture
  adr/README.md           decision log (the "why")
  milestones/MN.md         intent → acceptance → built (the traceability backbone)
```

## Dev workflow

```bash
pnpm install            # kuzu's native build is allowlisted via pnpm.onlyBuiltDependencies
pnpm typecheck          # tsc -p tsconfig.json (whole workspace, paths-mapped)
pnpm test               # vitest units + tsx integration scenarios (one process each)
pnpm test:unit          # vitest only       pnpm test:integration  # Kùzu/DB scenarios

# dev (tsx — convenient, but mind the Kùzu open-limit, ADR-17)
pnpm mcp                # MCP server on stdio
pnpm reviewer -- ...    # CLI

# production (bundled, run under node — stable, ADR-19)
pnpm build              # -> dist/reviewer.js, dist/reviewer-mcp.js
pnpm start -- index <repo> ; pnpm start -- review <repo> --staged
pnpm start:mcp          # the server an agent connects to
```

**How an agent uses it:** point Claude Code / Codex at the MCP server (`pnpm start:mcp`). Flow: `index_repo` once → `get_review_context` (blast radius + deterministic + knowledge + plex.md) → reason → `submit_findings` (returns the ranked, triaged stream) → `record_outcome` per finding (waivers + learning). `seed_knowledge`/`consolidate_knowledge`/`propose_promotions` manage the knowledge base.

Packages are ESM, source-only (`exports` points at `src/index.ts`); `tsx`/`vitest` run TS directly — no build step in dev. Internal imports use `@plex/<pkg>` (aliased in `tsconfig.json` and `vitest.config.ts`).

## Local services (must remember)

- **Kùzu** is embedded — no server. The per-repo code graph is a single file at `<repo>/.plex/graph.kuzu`. The knowledge base is a separate JSON store (ADR-18). Pinned image: `kuzudb/explorer:0.11.3` (matches `kuzu@0.11.3`).
- **FalkorDB** is the per-PR **working-memory brain** and is **required for the review flow** (ADR-22, M6 — supersedes its old "optional" status): it holds rounds/findings/verdicts/comments and powers the round-aware "changed-without-feedback" signal. Run it with AOF via Docker Compose (pinned `falkordb/falkordb:v4.18.9`):
  ```bash
  pnpm db:up     # plex-falkordb (--appendonly yes): redis on :56379, Browser on http://localhost:53000
  ```
  Ports are in the rarely-used 5xxxx range (override in `.env`). Set `PLEX_FALKORDB_URL=redis://localhost:56379`. The MCP server enables FalkorDB by default and **errors** (clear "run `pnpm db:up`") if it's unreachable — no in-process fallback. The CLI keeps `--falkor` opt-in for quick local checks. **Embeddings are also required for the brain** (semantic attribution, ADR-13): set `PLEX_EMBEDDING_PROVIDER` + key.

### Native-integration gotchas (hard-won — see ADR-16, ADR-17)

- **Kùzu + FalkorDB SIGSEGV in the same process.** Never `import('falkordb')` in a process that loaded the Kùzu addon. ALL FalkorDB I/O (reads *and* writes since M6) goes through the isolated child (`packages/neighborhood/src/falkor-worker.mjs`, a generic `runFalkor` Cypher executor). Keep it that way. Corollary (M6): a Kùzu-loaded process that *spawns* that worker SIGSEGVs on teardown **under tsx** — so the PR-brain E2E runs the built CLI under **node** (`pnpm test:brain`), not the tsx runner; the long-lived node MCP server is fine.
- **tsx + Kùzu crashes after ~5 `Database` opens in one process.** Plain `node` is stable (12+). So: integration tests run one scenario per tsx process (`pnpm test:integration`), vitest holds only pure units (`pnpm test:unit`), and the shipped server should run built JS under node — not tsx — and **reuse a `Database` per dir** rather than open/close per request.
- Always close the Kùzu `Connection` before the `Database` (`CodeGraphDB.close()`).
- Adding a `.test.ts` that opens Kùzu will crash vitest teardown — put it in `integration.mts` instead.

## Conventions & guidelines

- **Verify against reality, not memory.** Both DB clients were validated by smoke tests; when using a new API, check the package's `.d.ts` first (we did this for `kuzu@0.11.3`).
- **Kùzu queries:** use *prepared statements with named `$params`* for anything containing file paths/user data — never string-concatenate. Undirected traversal `-[r:Rel]-` works; frontier expansion uses `WHERE x.id IN $ids`.
- **Pure core, impure edges:** keep scoring/ranking/co-change math as pure functions (unit-tested without I/O); isolate git/Kùzu/FalkorDB calls at the boundaries.
- **Tests prefer real fixtures:** diff/graph tests build a throwaway git repo + in-memory/temp Kùzu DB rather than synthetic strings (a hand-written multi-file diff already fooled `parse-diff` once — see M0 notes).
- **Provenance is mandatory** on knowledge: every Pitfall links its source Incidents; every graph edge carries `provenance` + `weight`.
- **Document as you go:** each milestone gets a `docs/milestones/MN.md` (intent → acceptance criteria → what was built → verification). New decisions/deviations get an ADR. This is the user's explicit "always check we did what we intended" requirement — honor it.

## Must-remember invariants (easy to get wrong)

1. **Severity and confidence are separate axes** (ADR-04). "Potential bug" = `bug` severity + low confidence. Never collapse them.
2. **Prevalence is read by severity** (ADR-05): common *style* → demote to convention; common *bug* → escalate as a systemic migration. Suppression must never silence widespread real bugs.
3. **Blast radius ≈ coupling, not a precise call graph** (ADR-06). Co-change (git) is the strongest signal for runtime coupling like injected/DI services; imports miss it; precise TS edges are *enrichment*, not the base.
4. **Co-change must be weighted** (ADR-06): contribution ∝ 1/(commit size) and decays by recency; commits touching > `maxCommitFiles` contribute ≈0 (kills lint/format-sweep noise and the N² blowup).
5. **The reviewer never sees the author's reasoning** (ADR-02). Review state (raised/resolved/waived) is fed as *facts* from our store, never as prior chain-of-thought — that's the anti-bias mechanism.
6. **RAG, not fine-tuning** (ADR-01). The model stays a frontier model; our value is the retrieved context + feedback loop.
7. **v1 is TS/JS via the TS compiler API** (ADR-15), not tree-sitter. Other languages plug in behind the same extractor interface later.

## Mining (M4) — populate knowledge from PR history

**Distillation is LLM-only (ADR-20)** — no heuristic; a keyword matcher can't judge what's worth storing, so the LLM decides (it can SKIP a cluster). Two paths:
- **Agent-driven (rides your subscription):** MCP `mine_scan` (incremental — skips scanned PRs) returns clusters → the connected agent distills them → `add_pitfalls` stores them. No API key.
- **Standalone:** `plex mine [--reset] [--all]` / MCP `mine_history` — distills via the local `claude` CLI by default (subscription, no key), or `anthropic`/`openai` via `PLEX_LLM_PROVIDER` + key. **Errors** if no LLM is available (never stores low-quality pitfalls).

**Scope (ADR-21):** the LLM marks each pitfall `global` (everywhere) or `repo` (project-specific — still stored, retrieved only for that repo). Project-specific lessons are kept, not discarded.

Incremental cursor lives at `<repo>/.plex/mining-state.json`. Every substantive comment becomes a provenance `Incident`; `consolidate_knowledge` later reinforces pitfall confidence from outcomes.

## Scope

- **Done:** M0 scaffolding, M1 review loop, M2 precision/determinism, M3 knowledge, **M4 mining**, M5 promotion + viz + build, **M6 PR brain (round-aware review + changed-without-feedback + audit log)**, **M7 incremental indexing + graph staleness + git hooks**, **M8 truly-incremental co-change + semantic waiver suppression**, **M9 autonomous review (outcomes inferred from response, no verdict prompts)**.
- **Out of scope (by request):** the multi-repo workspace in M5.

## Status

All milestones complete (M0–M9). See `docs/milestones/` for per-milestone records and `docs/adr/README.md` for the 28 decisions. `pnpm test` green (51 unit + 10 integration); the PR brain is verified E2E under node via `pnpm test:brain`; `pnpm build` produces node-runnable binaries. Keep the graph fresh with `plex index --incremental` (TS *and* co-change are now incremental — or `plex install-hooks`); a review **auto-refreshes** the graph incrementally if it has drifted behind HEAD (opt out with `autoIndex:false`). Reviews are **autonomous** — submit findings and stop; a finding addressed by a later change is auto-`accept`ed on the next round (ADR-28), reject stays agent/responder-driven, silence infers nothing. Waivers suppress the same issue across rounds by meaning (semantic). `reconcile` (MCP `reconcile_outcomes` / `plex reconcile`) is the cheap, Kùzu-free "did the author fix these?" check to call after a push / on thread-resolution — not a pre-push git hook (which would run DB/network on every push). The MCP server exposes 14 tools (FalkorDB + an embedding provider required for the review flow — M6).
