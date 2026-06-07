# AGENTS.md

Guide for humans and coding agents continuing work on **reviewer**. Read this first, then [`docs/architecture.md`](docs/architecture.md) and the decision log [`docs/adr/README.md`](docs/adr/README.md).

## What this is (in one breath)

`reviewer` is a **local-first code reviewer**. It is *not* a new LLM — it's an **MCP server + orchestration layer** that any coding agent (Claude Code, Codex) connects to. It makes that agent rigorous and *unbiased* by running review in a fresh process, grounding it in a **blast-radius map** (Kùzu code graph) and **accumulated review knowledge** (knowledge graph), and merging first-principles + knowledge-grounded + deterministic findings into one ranked stream that learns from the user's verdicts.

## Repo layout

```
packages/
  core/          shared types, config, provider interfaces (no deps)
  ingest/        diff adapters: local git + gh PR → NormalizedDiff
  code-graph/    Kùzu per-repo graph: TS symbols/imports + git co-change   [M1]
  neighborhood/  diff→symbols→blast radius (Kùzu) [M1]
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

## Reviewing Plex with Plex — the agent setup (contributors)

Plex **dogfoods itself**: this repo ships the same reviewer agent + skills + MCP registration that downstream users get, so a contributor's own PRs are reviewed by Plex. The setup follows the `.agents/` ↔ `.claude/` symlink convention (mirroring this repo's `CLAUDE.md → AGENTS.md`), so both Claude Code and Codex find it:

```
.mcp.json                                  # registers the `plex` MCP server (node dist/plex-mcp.js)
.claude/
  settings.json                            # enables the project MCP + a sensible permission allowlist
  agents/plex-reviewer.md                  # the fresh-context, unbiased reviewer subagent
  skills/pr-parallel-review    -> ../../.agents/skills/pr-parallel-review    (symlink)
  skills/pr-review-responder   -> ../../.agents/skills/pr-review-responder   (symlink)
  skills/pr-review-documenter  -> ../../.agents/skills/pr-review-documenter  (symlink)
.agents/skills/                            # the REAL skill files (Codex/other agents read these)
  pr-parallel-review/SKILL.md              # orchestrate a fan-out review when reviewPlan says so
  pr-review-responder/SKILL.md             # resolve PR feedback + close the Plex learning loop
  pr-review-documenter/SKILL.md            # capture durable lessons into AGENTS.md / ADR / milestone
```

**One-time:** `pnpm build` (the `.mcp.json` runs the *built* `dist/plex-mcp.js` under node — never tsx, ADR-17/19). Open the repo in Claude Code and approve the `plex` project MCP when prompted (or it's pre-enabled via `.claude/settings.json`).

**Crowded MCP sessions — `alwaysLoad`.** With many MCP servers connected, Claude Code **defers** most MCP tools behind tool-search (they aren't listed top-level), and a reviewer agent can waste minutes failing to find `mcp__plex__*` and fall back to a manual git review. The fix: `"alwaysLoad": true` on the plex server entry (`.mcp.json` here; or the per-project `~/.claude.json` registration `plex init` writes) — it exempts plex from deferral so its tools load eagerly. The server also declares `instructions` (helps tool-search), and the `plex-reviewer` agent is told to `ToolSearch("mcp__plex__")` if deferred and **never** fall back to a manual review. (Subagent `tools:` is an allow-list only — it does NOT un-defer.)

**The loop (dogfooding your own PR):**
1. `plex-reviewer` agent → `index_repo` (first time) → `get_review_context` → reason over the diff + blast radius → `submit_findings`, then stop (autonomous; no verdict prompts). For a **large** change, run the **`pr-parallel-review`** skill instead: it reads the `reviewPlan` Plex returns and, when the change splits into independent coupled clusters, fans out one reviewer per cluster and consolidates into one `submit_findings` (docs/design/parallel-review.md). The guardrail is conservative — small/tightly-coupled changes stay a single pass.
2. Address feedback with the `pr-review-responder` skill → after pushing fixes it calls `reconcile_outcomes` (auto-`accept`s what you fixed) and `record_outcome reject`/`acknowledge` only for explicit dismissals. Silence is never a verdict.
3. `pr-review-documenter` turns a recurring lesson into a durable doc (AGENTS.md / a new ADR / a milestone record).

Editing skills: change the real file under `.agents/skills/<name>/SKILL.md`; the `.claude/skills/<name>` symlink picks it up.

## Local services (must remember)

- **Kùzu** is embedded — no server. Per-repo data lives **outside the repo** by default at `~/.plex/repos/<id>/` (graph.kuzu, verdicts, log, head.sha) — Plex never writes into the user's tree (no `.gitignore` needed). `PLEX_DATA_DIR=.plex` opts into in-repo storage; the data dir is **self-ignoring** (`ensureDataDir` drops a `.gitignore` of `*` in it), so even the in-repo opt-in never needs hand-gitignoring. The knowledge base is a separate JSON store (ADR-18).
- **The PR brain is embedded Kùzu** (`<repo-data>/brain.kuzu`) — rounds/findings/verdicts/comments + the round-aware "changed-without-feedback" signal. **No FalkorDB, no Docker, no service** (ADR-30, M11 — supersedes ADR-07/22). A review needs nothing running. **Embeddings are optional** (ADR-30): without a provider the brain still records rounds/findings; only the semantic signals (unexplained changes + fix inference) are skipped. Set a provider once via `plex init` (→ `~/.plex/config.json`) or `PLEX_EMBEDDING_PROVIDER` + key. The brain is **per-machine** (keyed by local path); a *team-shared* brain is an explicit non-goal of the embedded design — options + the identity/concurrency tension are explored in [`docs/design/shared-brain.md`](docs/design/shared-brain.md).

### Native-integration gotchas (hard-won — see ADR-16, ADR-17)

- **FalkorDB is gone (M11/ADR-30)** — the brain is Kùzu now, so the Kùzu+FalkorDB SIGSEGV class and the isolated worker are retired. Kùzu+Kùzu share a process fine. The **tsx Kùzu open-limit (ADR-17) still applies**: keep tsx integration scenarios to **≤2 Kùzu opens**, and the full-review E2E stays a **node** check (`pnpm test:brain`). A review opens Kùzu once for the neighborhood + once for the brain; any auto-index/refresh runs in an **isolated child** so the review process never exceeds that.
- **tsx + Kùzu crashes after ~5 `Database` opens in one process.** Plain `node` is stable (12+). So: integration tests run one scenario per tsx process (`pnpm test:integration`), vitest holds only pure units (`pnpm test:unit`), and the shipped server should run built JS under node — not tsx — and **reuse a `Database` per dir** rather than open/close per request.
- Always close the Kùzu `Connection` before the `Database` (`CodeGraphDB.close()`).
- Adding a `.test.ts` that opens Kùzu will crash vitest teardown — put it in `integration.mts` instead.

## Conventions & guidelines

- **Verify against reality, not memory.** Both DB clients were validated by smoke tests; when using a new API, check the package's `.d.ts` first (we did this for `kuzu@0.11.3`).
- **Kùzu queries:** use *prepared statements with named `$params`* for anything containing file paths/user data — never string-concatenate. Undirected traversal `-[r:Rel]-` works; frontier expansion uses `WHERE x.id IN $ids`.
- **Pure core, impure edges:** keep scoring/ranking/co-change math as pure functions (unit-tested without I/O); isolate git/Kùzu calls at the boundaries.
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

**Outcome signal today is coarse** — `outcomeFor` is binary (PR merged → `accepted`, else `rejected`); thread `isResolved` and the resolving diff are NOT used, so `fixed`/`reverted` (and the `reverted: 1.5` weight) are unrealized. Plan + the rate-limit/attribution risks for a richer signal: [`docs/design/outcome-signals.md`](docs/design/outcome-signals.md).

## Scope

- **Done:** M0 scaffolding, M1 review loop, M2 precision/determinism, M3 knowledge, **M4 mining**, M5 promotion + viz + build, **M6 PR brain**, **M7 incremental indexing + staleness + hooks**, **M8 incremental co-change + semantic waivers**, **M9 autonomous review**, **M10 one-command setup + centralized storage**, **M11 brain on Kùzu (FalkorDB removed; embeddings optional; auto-index)**, **M12 `awareness` findings + `acknowledge` verdict**. Post-M12 (ADR-only): worktree graph seeding (ADR-32), Kùzu Explorer / all Docker removed (ADR-33), PR auto-comment (ADR-34), chronological mining (`--oldest`) + the clusterThreshold-for-real-embeddings fix.
- **Out of scope (by request):** the multi-repo workspace in M5.

## Status

All milestones complete (M0–M12). See `docs/milestones/` for per-milestone records and `docs/adr/README.md` for the decision log (through ADR-34). **Fully embedded (Kùzu) — no services, no Docker (ADR-30/33).** `pnpm test` green (213 unit + 13 integration); the PR brain + worktree-seeding are verified E2E under node via `pnpm test:brain` / `pnpm test:worktree`; `pnpm build` produces node-runnable binaries. Install: `plex init` (optional — asks for a key, registers the MCP, indexes) or just review — the **first review auto-indexes** the repo, and reviews auto-refresh the graph on drift. Reviews are **autonomous** — submit findings and stop; a finding addressed by a later change is auto-`accept`ed (ADR-28), reject stays agent/responder-driven, silence infers nothing. Verdicts also include **`acknowledge`** (M12) for an `awareness` flag confirmed intentional. **PR auto-comment** (ADR-34, opt-in `autoComment`) posts the ranked review back to the GitHub PR — one review, inline + summary, deduped per round — for the `pr-review-responder` skill to triage. Waivers suppress the same issue across rounds by meaning (semantic). `reconcile` (MCP `reconcile_outcomes` / `plex reconcile`) is the cheap "did the author fix these?" check for after a push. The MCP server exposes 14 tools; per-repo data lives outside the repo (`~/.plex/repos/<id>`).
