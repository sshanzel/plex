# Plex

**A local-first AI code reviewer.** Plex isn't another LLM — it's an **MCP server + CLI** that makes the coding agent you already use (Claude Code, Codex, …) far more **rigorous** and **unbiased**, and sharper the more you use it.

- **Unbiased** — reviews in a **fresh process**, so it never anchors on the reasoning of whoever wrote the code, even across rounds.
- **Grounded** — a **blast-radius map** (git co-change + imports + precise TS edges) shows what *else* a change can break, not just the diff.
- **Compounding** — review **knowledge** that grows globally (across your repos) and per-project, reweighted by your verdicts and mined from PR history.
- **One stream** — first-principles reasoning, learned pitfalls, and deterministic checks, merged and ranked by severity × confidence × blast.

The reasoning stays the frontier model's; Plex feeds it the right context and remembers what it learns.

## Why

Copilot review hits limits, the Claude solo plan has no review, and the agent that *wrote* the code is a biased reviewer of it. Plex is the unbiased second pair of eyes — running on the subscription you already have.

## How it works

```
 diff (local / gh PR)
        │
        ▼  Plex MCP server (fresh, unbiased) — assembles grounding:
   blast radius (Kùzu code graph)  ·  deterministic checks  ·  relevant pitfalls  ·  plex.md
        │
        ▼  get_review_context
   your agent reasons (first-principles + grounded)
        │
        ▼  submit_findings  →  merge · dedup · rank · triage (severity × confidence × blast − waivers)
        │                       └─ (PR + opt-in) post the stream back as ONE GitHub review
        ▼  record_outcome (accept / reject / waive / acknowledge)  →  knowledge sharpens; confirmed bugs → incidents
```

**Close the loop on a PR (opt-in).** Turn on `autoComment` and a PR review posts the ranked stream as one GitHub review — inline comments on changed lines + a summary for coupled/awareness findings, deduped across rounds — which **`/pr-master:respond`** then triages (you decide) and reconciles back into the knowledge (ADR-34).

**Three finding sources, one stream:** first-principles (the agent), knowledge-grounded (retrieved pitfalls), and deterministic (built-in TS-AST checks + optional Semgrep/ast-grep). Prevalence is read by severity — a common *style* is a convention (demoted); a common *bug* is systemic (escalated as a migration).

**Two layers of knowledge that compound:**

- **Global** — universal pitfalls + your review style, mined across all repos, reweighted by outcomes. Applies everywhere.
- **Per-project** — that repo's code graph + co-change coupling, **repo-scoped pitfalls**, and its `plex.md` instructions. Tailors review to one codebase.

**Mining** turns PR-review history into pitfalls: it pulls review comments via `gh`, denoises, clusters similar ones, and an **LLM distills** each cluster (deciding what's worth keeping and whether it's global or project-specific). Distillation rides your subscription — either the connected agent (`mine_scan` → `add_pitfalls`) or the local `claude` CLI (`plex mine`). Incremental: a per-repo cursor only pulls new PRs.

## Quick start

The whole point of Plex is that a review runs in a **separate, unbiased context** — a dedicated reviewer *agent*, never raw MCP calls in the chat that wrote the code (that would just reintroduce the bias). So the agent and the MCP engine it runs on are **one system**, and installing the plugin sets up both:

**Claude Code**

```
/plugin marketplace add sshanzel/plugins
/plugin install plex@sshanzel
```

**Codex** — the same plugin from this repo's Codex marketplace (Codex has no "agent" type, so the reviewer ships as a **`plex-review`** skill alongside the `plex-parallel-review` orchestrator):

```
codex plugin marketplace add sshanzel/plex
```

One install brings the three pieces that *are* the reviewer: the **fresh-context agent** (`plex-reviewer` / the `plex-review` skill), the **`/plex:review` command**, and the **MCP engine** it calls (auto-run via `npx` — nothing else to install). Fully embedded (Kùzu): no Docker, no services.

**Set an embedding key** to power the knowledge base + semantic signals — the part that *learns* across reviews: run `npx @sshanzel/plex init`, or edit `~/.plex/config.json`.

Then, in any repo, run **`/plex:review`** — or just ask *"review my changes with Plex."* (Codex: the `plex-review` skill via `/skills` or `$plex-review`.) The reviewer is **on-demand**; the **first review auto-indexes** the repo and the graph **auto-refreshes** on drift.

> Updates are a `git push` to the marketplace. Claude: `/plugin marketplace update` + `/reload-plugins`. Codex: `codex plugin marketplace upgrade`. The MCP engine updates separately on npm.

## CLI (setup & maintenance)

The plugin *is* the reviewer; the CLI is that same engine for the **non-review** jobs — setting the embedding key, (re)building the code graph, and growing the knowledge base. A review always runs through the isolated agent, so there is no CLI `review`. **Run it inside your repo** — every command defaults to the current git repo.

```bash
npm i -g @sshanzel/plex          # or run ad-hoc: npx @sshanzel/plex <cmd>

cd your-repo
plex init                        # set the embedding key + offer to index (interactive setup)
plex index                       # (re)index the code graph — add --incremental for just changed files
plex mine                        # build knowledge from this repo's PR history (rides your claude sub)
plex seed                        # seed pitfalls from ./plex.md
plex doctor                      # embeddings + graph status
```

Full command list: `init · doctor · index [--incremental] · seed · mine · promote · reconcile · eval · blast · verdict · verdicts`.

> Per-repo data lives **outside your repo** at `~/.plex/repos/<id>/` — nothing to `.gitignore`. Switching embedding providers invalidates stored vectors (ADR-13): `rm -rf ~/.plex/knowledge` and re-seed/-mine.

### From source (contributors)

```bash
pnpm install && pnpm build         # → dist/plex.js, dist/plex-mcp.js (run under node; ADR-19)
node dist/plex.js index            # build the graph for the current repo
```

## MCP tools (15)

`index_repo` · `get_review_context` · `get_blast_radius` · `get_deterministic_findings` · `submit_findings` · `record_outcome` · `reconcile_outcomes` · `get_relevant_knowledge` · `seed_knowledge` · `consolidate_knowledge` · `propose_promotions` · `mine_scan` · `add_pitfalls` · `mine_history` · `doctor`

## Architecture

- **MCP server + CLI** — the integration seam; the agent brings the LLM, Plex brings grounding + memory.
- **Kùzu** (embedded, MIT) — durable per-repo code graph (symbols, imports, co-change, precise alias edges) **and** the per-PR brain (rounds, findings, verdicts, comments, the *changed-without-feedback* signal). One embedded engine, no service (ADR-30). Built once, refreshed incrementally; reviews auto-index/auto-refresh on first use / drift.
- **Knowledge base** — JSON-backed pitfalls + incidents with embeddings; pluggable, **optional** embedding provider (Voyage / OpenAI / Gemini / Ollama). Waivers suppress the same issue across rounds *by meaning* (semantic), surviving line drift / rewording.

See [`docs/architecture.md`](docs/architecture.md) and the decision log in [`docs/adr/README.md`](docs/adr/README.md).

## Configuration

Environment variables (all optional):

Set once via `plex init` (→ `~/.plex/config.json`), or as process env (which overrides the file):

| Var | Purpose |
|---|---|
| `PLEX_EMBEDDING_PROVIDER` | **optional** — semantic knowledge + brain signals: `voyage` \| `openai` \| `gemini` \| `ollama` (`none` = off; `fake` is test-only) |
| *(provider key)* | `VOYAGE_API_KEY` \| `OPENAI_API_KEY` \| `GEMINI_API_KEY` (Ollama needs none) |
| `PLEX_LLM_PROVIDER` | mining distiller: `claude-cli` (default) \| `anthropic` \| `openai` |
| `PLEX_DATA_DIR` | per-repo data dir (default `''` = centralized `~/.plex/repos/<id>`; `.plex` = in-repo, self-ignored) |
| `PLEX_KNOWLEDGE_DIR` | global knowledge base (default `~/.plex/knowledge`) |
| `PLEX_AUTO_COMMENT` | post a PR review's findings back to the GitHub PR (off by default; `PLEX_AUTO_COMMENT_SKIP_NITS=true` to drop nits — nits post otherwise) |

## Status

All milestones complete (M0–M12). `pnpm test` runs the unit (vitest, 229) + integration (tsx) suites; `pnpm test:brain` + `pnpm test:worktree` verify the PR brain and worktree-seeding end-to-end under node; `pnpm build` produces node-runnable binaries. Built with TypeScript/Node and pnpm workspaces, fully embedded (Kùzu — no Docker, no services). See [`docs/milestones/`](docs/milestones/) and the [decision log (through ADR-36)](docs/adr/README.md).

## License

[MIT](LICENSE)
