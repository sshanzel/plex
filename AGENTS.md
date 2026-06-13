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
  deterministic/ built-in TS-AST codified checks                          [M2]
  knowledge/     knowledge graph + retrieval (learned)                 [M3]
  mcp-server/    MCP tool surface + orchestration
  viz-server/    optional local UI daemon: code graph + brain + knowledge [M13]
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

**How an agent uses it:** point Claude Code / Codex at the MCP server (`pnpm start:mcp`). Flow: `index_repo` once → `get_review_context` (blast radius + deterministic + knowledge) → reason → `submit_findings` (returns the ranked, triaged stream) → `record_outcome` per finding (waivers + learning). `consolidate_knowledge` and the analysis tools manage the knowledge base (learned — no markdown seeding; ADR-37).

Packages are ESM, source-only (`exports` points at `src/index.ts`); `tsx`/`vitest` run TS directly — no build step in dev. Internal imports use `@plex/<pkg>` (aliased in `tsconfig.json` and `vitest.config.ts`).

## Reviewing Plex with Plex — the agent setup (contributors)

Plex **dogfoods itself**: this repo ships the same reviewer agent + MCP registration that downstream users get, so a contributor's own PRs are reviewed by Plex. The agent's canonical home is **`plugin/`** (the distributed plex plugin); the `.agents/` ↔ `.claude/` entries are symlinks pointing **into** it (mirroring this repo's `CLAUDE.md → AGENTS.md` convention), so both Claude Code and Codex find them. The PR-workflow commands (`/pr-master:respond`, `/pr-master:postmortem`, …) come from the **`pr-master@sshanzel`** plugin, enabled in `.claude/settings.json`:

```
.mcp.json                                  # registers the `plex` MCP server (node dist/plex-mcp.js)
.claude/
  settings.json                            # project MCP + pr-master@sshanzel + a permission allowlist
  agents/plex-reviewer.md      -> ../../plugin/agents/plex-reviewer.md         (symlink → plugin/)
plugin/                                    # the REAL files — single source of truth (see Distribution)
  agents/plex-reviewer.md                  # the fresh-context, unbiased reviewer subagent
```

**One-time:** `pnpm build` (the `.mcp.json` runs the *built* `dist/plex-mcp.js` under node — never tsx, ADR-17/19). Open the repo in Claude Code and approve the `plex` project MCP when prompted (or it's pre-enabled via `.claude/settings.json`).

**Crowded MCP sessions — `alwaysLoad`.** With many MCP servers connected, Claude Code **defers** most MCP tools behind tool-search (they aren't listed top-level), and a reviewer agent can waste minutes failing to find `mcp__plex__*` and fall back to a manual git review. The fix: `"alwaysLoad": true` on the plex server entry (`.mcp.json` here; or the per-project `~/.claude.json` registration `plex init` writes) — it exempts plex from deferral so its tools load eagerly. The server also declares `instructions` (helps tool-search), and the `plex-reviewer` agent is told to `ToolSearch("mcp__plex__")` if deferred and **never** fall back to a manual review. (Subagent `tools:` is an allow-list only — it does NOT un-defer.)

**The loop (dogfooding your own PR):**
1. `plex-reviewer` agent → `index_repo` (first time) → `get_review_context` → reason over the diff + blast radius → `submit_findings`, then stop (autonomous; no verdict prompts).
2. Address feedback with **`/pr-master:respond`** (the pr-master plugin) → after pushing fixes it calls `reconcile_outcomes` (auto-`accept`s what you fixed) and `record_outcome reject`/`acknowledge` only for explicit dismissals. Silence is never a verdict.
3. Durable lessons accrue in **Plex's own knowledge/brain** as you record outcomes; when a recurring pattern is worth a written guardrail, **`/pr-master:postmortem`** distills a merged PR's review themes into an `AGENTS.md` / ADR / milestone note (this supersedes the old `pr-review-documenter` skill).

Editing the agent: change the real file under **`plugin/agents/plex-reviewer.md`** (the canonical home); the `.claude/` symlink picks it up (see **Distribution** below).

### Distribution (Claude Code plugin via the `sshanzel/plugins` hub)

Downstream users install via a **plugin — Claude Code *or* Codex** — not by cloning this repo. One
`plugin/` dir carries both: each agent reads its own manifest and ignores the other's.

- **Claude Code** installs from the **`sshanzel/plugins`** hub marketplace, which pulls THIS repo's
  `plugin/` via a `git-subdir` source (a sparse clone of just `plugin/` — no monorepo cruft). So
  `plugin/` must be **self-contained** (real files, no symlink escaping the dir).
- **Codex** installs from this repo's own Codex marketplace at the repo root
  (`.agents/plugins/marketplace.json` → `./plugin`): `codex plugin marketplace add sshanzel/plex`.

```
plugin/                                     # the "plex" plugin — Claude AND Codex read this one dir
  .claude-plugin/plugin.json               # Claude manifest (versioned — bumped in lockstep by `pnpm release`)
  .codex-plugin/plugin.json                # Codex manifest → skills: ./codex/skills/
  .mcp.json                                # launches the engine for BOTH: npx -y -p @sshanzel/plex@<pinned> plex-mcp
  commands/review.md                        # Claude: the /plex:review command
  agents/plex-reviewer.md                  # Claude: the reviewer subagent — REAL file, canonical
  scripts/gen-codex-skills.mjs             # generates codex/skills/ from the agent
  codex/skills/                            # GENERATED + committed (Codex has no agent/command type):
    plex-review/SKILL.md                   #   the agent → a plex-review skill (Codex-neutral tool wording)
.agents/plugins/marketplace.json           # (repo ROOT, not in plugin/) the Codex marketplace → ./plugin
```

`plugin/` is the **single source of truth**: Claude reads `agents/` + `commands/`; Codex reads
`codex/skills/`. The agent is canonical and **`codex/skills/` is generated** — edit
`agents/plex-reviewer.md`, then `node plugin/scripts/gen-codex-skills.mjs` and commit (the
generated files are committed so the Codex marketplace clone has them). **Dogfooding symlink points
*into* `plugin/`** (`.claude/agents/plex-reviewer.md` → `plugin/…`). Do NOT reintroduce a symlink
that escapes `plugin/` — `git-subdir` sparse-clones only that dir for Claude, so an escaping link
would break users' installs.

Install — Claude: `/plugin marketplace add sshanzel/plugins` → `/plugin install plex@sshanzel`.
Codex: `codex plugin marketplace add sshanzel/plex` (then the `plex-review` skill). **Naming rule:**
`plex-*` (the reviewer agent + `plex-review` Codex skill) are Plex-coupled and ship in this plugin;
the general PR-workflow skills live in the `pr-master` plugin (also in `sshanzel/plugins`) and only
*detect* Plex. **The plugin pins the engine version** — `plugin/.mcp.json` launches
`npx -y -p @sshanzel/plex@<version> plex-mcp` with an *exact* pin, so plugin (MD files) and engine
(npm) ship in **lockstep**: publishing a new npm version reaches no one until the plugin's pin is
bumped, and updating the plugin delivers the matching engine. The exact pin also dodges npx's stale
`latest` cache (a new version = a new spec = a fresh fetch). **Releasing:** `pnpm release
<patch|minor|major|X.Y.Z>` does the lockstep dance — deterministic gates (typecheck/test/build) →
bump BOTH `package.json` and the `plugin/.mcp.json` pin → commit + tag → `npm publish` → push →
`gh release` (run it locally; `npm publish` needs your auth/OTP). The gate skips the kuzu-native
E2Es (the indexing SIGSEGV flake, ADR-17) since CI runs them on every push — so the release command stays
reliable. **The flake is now retried, not just tolerated:** every E2E check script's `cli` helper and
the product's `indexIsolated` retry a `SIGSEGV` (only that signal — a real failure stops early), since
`index` is idempotent. On Linux the per-index crash rate is high enough that a single attempt failed
CI ~90% of runs (~6 indexes/check); the retry makes both CI and a real Linux user's auto-index reliable.
An un-bumped pin would leave users on the old
engine even after a plugin update, which is exactly the step the script keeps you from forgetting.

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
- **Quality floors are part of the test suite** ([`docs/design/evals.md`](docs/design/evals.md)): `ranking-quality.test.ts` and `retrieval-quality.test.ts` assert nDCG/recall floors over frozen labeled corpora. A change that trips a floor is a finding about the change — don't lower the floor to pass; a change that raises the score should ratchet the floor up in the same commit.
- **Document as you go:** each milestone gets a `docs/milestones/MN.md` (intent → acceptance criteria → what was built → verification). New decisions/deviations get an ADR. This is the user's explicit "always check we did what we intended" requirement — honor it.

## Must-remember invariants (easy to get wrong)

1. **Severity and confidence are separate axes** (ADR-04). "Potential bug" = `bug` severity + low confidence. Never collapse them.
2. **Prevalence is read by severity** (ADR-05): common *style* → demote to convention; common *bug* → escalate as a systemic migration. Suppression must never silence widespread real bugs.
3. **Blast radius ≈ coupling, not a precise call graph** (ADR-06). Co-change (git) is the strongest signal for runtime coupling like injected/DI services; imports miss it; precise TS edges are *enrichment*, not the base.
4. **Co-change must be weighted** (ADR-06): contribution ∝ 1/(commit size) and decays by recency; commits touching > `maxCommitFiles` contribute ≈0 (kills lint/format-sweep noise and the N² blowup).
5. **The reviewer never sees the author's reasoning** (ADR-02). Review state (raised/resolved/waived) is fed as *facts* from our store, never as prior chain-of-thought — that's the anti-bias mechanism.
6. **RAG, not fine-tuning** (ADR-01). The model stays a frontier model; our value is the retrieved context + feedback loop.
7. **v1 is TS/JS via the TS compiler API** (ADR-15), not tree-sitter. Other languages plug in behind the same extractor interface later.

## Analyzing PR review history (M4) — populate knowledge

**Distillation is LLM-only (ADR-20)** — no heuristic; a keyword matcher can't judge what's worth storing, so the LLM decides (it can SKIP a cluster). Two paths:
- **Agent-driven (rides your subscription):** MCP `analyze_scan` (incremental — skips scanned PRs) returns clusters → the connected agent distills them → `add_pitfalls` stores them. No API key.
- **Standalone:** `plex analyze [--reset] [--all]` / MCP `analyze_history` — distills via the local `claude` CLI by default (subscription, no key), or `anthropic`/`openai` via `PLEX_LLM_PROVIDER` + key. **Errors** if no LLM is available (never stores low-quality pitfalls).

**Scope (ADR-21):** the LLM marks each pitfall `global` (everywhere) or `repo` (project-specific — still stored, retrieved only for that repo). Project-specific lessons are kept, not discarded.

Incremental cursor lives at `~/.plex/repos/<id>/analyze-state.json` (in-repo at `.plex/analyze-state.json` only with the `PLEX_DATA_DIR=.plex` opt-in). Every substantive comment becomes a provenance `Incident`; `consolidate_knowledge` later reinforces pitfall confidence from outcomes.

**Outcome signal is OBSERVED, not assumed (ADR-44)** — `outcomeFor(c)` confirms (`fixed`) only when a comment is **outdated** (GitHub's `position` nulled → its hunk was changed by a later commit, `isOutdated`) **AND** the PR merged; everything else **abstains** (dropped from the confidence counts, never a manufactured confirm). Analysis never emits `rejected` — it can confirm a pattern but never refute one (refutation is the live-review `reject` path). Confidence is **one Wilson estimator everywhere** (`confidenceFromOutcomes`) — it replaced the `0.3 + 0.1·n` distill polynomial AND the `0.6` `add_pitfalls` default; the dead `outcomeWeight` table was deleted. Retrieval now **uses** confidence (a bounded tilt beside recency, so a better-evidenced pitfall ranks higher — floored, never buried). Still deferred to the hosted/API path (rate-limit discipline): thread `isResolved` corroboration + revert detection — [`docs/design/outcome-signals.md`](docs/design/outcome-signals.md).

## Scope

- **Done:** M0 scaffolding, M1 review loop, M2 precision/determinism, M3 knowledge, **M4 review-history analysis**, M5 promotion + viz + build, **M6 PR brain**, **M7 incremental indexing + staleness + hooks**, **M8 incremental co-change + semantic waivers**, **M9 autonomous review**, **M10 one-command setup + centralized storage**, **M11 brain on Kùzu (FalkorDB removed; embeddings optional; auto-index)**, **M12 `awareness` findings + `acknowledge` verdict**. Post-M12 (ADR-only): worktree graph seeding (ADR-32), Kùzu Explorer / all Docker removed (ADR-33), PR auto-comment (ADR-34), chronological analysis (`--oldest`) + the clusterThreshold-for-real-embeddings fix, supply-chain hardening posture (ADR-35), **git-hook auto-index removed — the review is the trigger (ADR-36)**, **`plex.md` + markdown seeding + the promotion/external-runner surface removed; knowledge is learned only (ADR-37)**, **review-history analysis named `analyze` (product) + `@plex/distill` (technique) (ADR-38)**, **learned suppression — negative pitfalls on a Wilson basis: dismissals weighted (never a one-click kill), `demoted` triage tier, language-gated cross-repo promotion; positive confidence unified on Wilson too (ADR-39, `docs/design/negative-knowledge.md`)**, **worktree read-only graph sharing reverted to copy + stored in-workspace — Kùzu 0.11.3's read-only open SIGSEGVs on Linux (ADR-40)**, **suppression recency-decay (reject fades / waive persists, wall-time, decayed-Wilson → also the re-surface mechanism) + first-principles suppression via semantic title-embedding keys; re-surface probe dropped (ADR-41)**, **positive-pitfall decay — recency-weighted reinforcement + retrieval recency-tilt + pruning (provenance survives); `config.decay`, `Pitfall.lastReinforcedAt` (ADR-42, `docs/design/knowledge-decay.md`)**, **the background maintenance worker — a detached, debounced, idempotent sweep that maintains `main` (resolved from any worktree): closes landed loops → global KB, refreshes main's graph (isolated child), runs the ADR-42 consolidate/decay + incremental analyze; supersedes the flaky pr-responder bookkeeping AND the git hooks ADR-36 removed; `plex sweep`, auto-spawned by review/reconcile (ADR-43, `docs/design/maintenance-worker.md`)**, **observed outcome signals + unified Wilson confidence — `outcomeFor` confirms only on an OBSERVED code change (GitHub-outdated + merged) and abstains otherwise (killing the "merged ⇒ accepted" manufactured confirm); `confidenceFromOutcomes` is one Wilson definition across distill/`add_pitfalls`/consolidate; retrieval gains a confidence tilt; dead `outcomeWeight` deleted (ADR-44, `docs/design/outcome-signals.md`)**.
- **Out of scope (by request):** the multi-repo workspace in M5.

## Status

All milestones complete (M0–M13). See `docs/milestones/` for per-milestone records and `docs/adr/README.md` for the decision log (through ADR-45). **Embedded (Kùzu) — no Docker, no external/native services (ADR-30/33), no git hooks (ADR-36).** **One optional local node daemon** for data visibility: `plex serve` (M13/ADR-45, `@plex/viz-server`) serves an interactive Cytoscape UI at `http://127.0.0.1:2288` over the code graph + PR brain + knowledge — **on-demand by default** (`plex serve` / `npx … plex serve`; it's a viewer, not a capturer), opt into always-on with `ui.autoStart`/`PLEX_UI_AUTOSTART` (then the MCP spawns it on startup), opens Kùzu per-request so it never blocks a review, binds loopback only. `pnpm test` green (PR brain + worktree-seeding verified E2E under node via `pnpm test:brain` / `pnpm test:worktree`); `pnpm build` produces node-runnable binaries. Install: `plex init` (optional — asks for a key, registers the MCP, indexes) or just review — the **first review auto-indexes** the repo, and reviews auto-refresh the graph on drift (**the review is the only trigger — no git hooks to install; ADR-36**). Reviews are **autonomous** — submit findings and stop; a finding addressed by a later change is auto-`accept`ed (ADR-28) — this runs on the **next review itself**, locality-matched with **no embeddings or responder required** (ADR-36), so a standalone install still closes the accept-loop on re-review; reject stays agent/responder-driven, silence infers nothing. Verdicts also include **`acknowledge`** (M12) for an `awareness` flag confirmed intentional. **PR auto-comment** (ADR-34, opt-in `autoComment`) posts the ranked review back to the GitHub PR — one review, inline + summary, deduped per round — for `/pr-master:respond` to triage. Waivers suppress the same issue across rounds by meaning (semantic). `reconcile` (MCP `reconcile_outcomes` / `plex reconcile`) is the cheap "did the author fix these?" check for after a push — it matches a fix to a finding by semantic title OR file/line **locality** (so a restructuring fix still reconciles), and returns a `reason` so `accepted: 0` is never a black box. The MCP server exposes 14 tools; per-repo data lives outside the repo (`~/.plex/repos/<id>`) — **except a linked git worktree, whose data (its copied graph + brain) lives IN the worktree at `<worktree>/.plex` (self-gitignored), so it dies with the worktree folder (ADR-40)**.

**The review target is path-derived, and the brain must not split.** All brain writes (round recording, finding writes, verdicts, reconcile, `record_outcome`) key off **`reviewTargetFor(repoPath, src)`** = `reviewTarget(basename(resolve(repoPath)), src)` — never the code graph's `repo` meta. A secondary worktree seeds its graph by copying the base repo's graph (ADR-32), so the copy carries the BASE name while the worktree dir differs; keying rounds off graph-meta but findings off basename split the brain across two targets and made reconcile report `checked: N, accepted: 0` (it found the findings but no `lastHeadSha`). Route every new brain key through `reviewTargetFor` so they can't diverge. As belt-and-suspenders, `Brain.healSplitTarget` (run on every reconcile/review) realigns a brain if rounds and findings ever DO land under sibling targets — a **permanent, cheap invariant guard** (fires only on the split signature, else one COUNT), not one-off migration; keep it.

**Long-lived stdio server — config is live, code is not.** Config is **re-read per tool call**, so edits to `~/.plex/config.json` (an embedding key, `autoComment`, thresholds) take effect with no restart. A **code** change (rebuild / package update) does NOT — the client keeps the stdio process warm and it runs the build it loaded at spawn until reconnected. Don't trust idle-respawn timing; reconnect Plex (`/mcp` → reconnect plex) after a `pnpm build`. The **`doctor`** MCP tool reports the running version, whether a newer build is on disk (`stale: true` → reconnect), and the effective config — call it when a fix or setting "didn't seem to apply."
