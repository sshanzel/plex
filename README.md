# Plex

**A local-first, open-source AI code reviewer.** Plex isn't another LLM that reviews your code — it's an **MCP server + CLI** that makes whatever coding agent you already use (Claude Code, Codex, …) dramatically more **rigorous** and **unbiased**, and gets better the more you use it.

It does that by:

- running review in a **fresh process**, separate from whoever wrote the code — no self-review bias, even across rounds;
- grounding the review in a **blast-radius map** of your codebase (git co-change + imports + precise TS edges) so it sees what *else* a change can break;
- focusing it with **accumulated review knowledge** that compounds **globally** (across all your repos) and **per-project** (tailored to one codebase);
- merging the agent's first-principles reasoning, learned pitfalls, and deterministic checks into **one severity- and confidence-ranked stream**;
- **learning** from your accept/reject/waive verdicts and from mining your PR-review history.

The reasoning stays the frontier model's; Plex's job is to feed it the right context and remember what it learns. (RAG, not fine-tuning.)

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
        │
        ▼  record_outcome (accept / reject / waive)  →  knowledge sharpens; confirmed bugs → incidents
```

**Three finding sources, one stream:** first-principles (the agent), knowledge-grounded (retrieved pitfalls), and deterministic (built-in TS-AST checks + optional Semgrep/ast-grep). Prevalence is read by severity — a common *style* is a convention (demoted); a common *bug* is systemic (escalated as a migration).

**Two layers of knowledge that compound:**

- **Global** — universal pitfalls + your review style, mined across all repos, reweighted by outcomes. Applies everywhere.
- **Per-project** — that repo's code graph + co-change coupling, **repo-scoped pitfalls**, and its `plex.md` instructions. Tailors review to one codebase.

**Mining** turns PR-review history into pitfalls: it pulls review comments via `gh`, denoises, clusters similar ones, and an **LLM distills** each cluster (deciding what's worth keeping and whether it's global or project-specific). Distillation rides your subscription — either the connected agent (`mine_scan` → `add_pitfalls`) or the local `claude` CLI (`plex mine`). Incremental: a per-repo cursor only pulls new PRs.

## Quick start

Plex is **fully embedded** (Kùzu) — no Docker, no services, nothing to run. A review works against any git repo with zero setup; an embedding provider is **optional** (it adds semantic knowledge + the semantic review signals).

```bash
pnpm install
pnpm build                         # → dist/plex.js, dist/plex-mcp.js  (run under node; ADR-19)

# Optional: one-command setup (asks for an embedding key, registers the MCP, indexes this repo)
node dist/plex.js init

# …or just review — the first review AUTO-INDEXES the repo, no prior step needed:
node dist/plex.js review /path/to/repo --staged     # or --branch main / --pr 123 / --html nb.html

# Optional: keep the graph fresh automatically on pull/checkout/rebase
node dist/plex.js install-hooks /path/to/repo
#   manual refresh is O(changed files):  node dist/plex.js index /path/to/repo --incremental

# Optional: an embedding provider (semantic knowledge + brain signals). Set once in
# ~/.plex/config.json via `init`, or export:
export PLEX_EMBEDDING_PROVIDER=voyage              # voyage | openai | gemini | ollama
export VOYAGE_API_KEY=...                           # or OPENAI_API_KEY / GEMINI_API_KEY; ollama needs none
node dist/plex.js mine /path/to/repo                # build knowledge from PR history (rides your claude sub)
node dist/plex.js seed /path/to/repo               # seed from <repo>/plex.md
```

> Per-repo data lives **outside your repo** at `~/.plex/repos/<id>/` (nothing to `.gitignore`). Switching embedding providers invalidates stored vectors (ADR-13): `rm -rf ~/.plex/knowledge` and re-seed/-mine. `plex doctor` shows status.

### Use it from Claude Code (MCP)

```bash
node dist/plex.js init          # registers the MCP for you, …or do it manually:
claude mcp add plex -- node /abs/path/to/dist/plex-mcp.js
```
The MCP reads `~/.plex/config.json` (your embedding key) — no secrets in the registration. Then restart Claude Code and, inside a target repo, ask *"review my changes with Plex."* A ready-made review subagent is at [`.claude/agents/`](.). (Verify end-to-end any time with `pnpm test:brain`.)

## Inspecting a review (optional)

`plex review --html` writes a single self-contained Cytoscape file — the changed symbols and their blast-radius neighbors. No services, nothing to run.

## CLI

`plex init · doctor · index [--incremental] · install-hooks · uninstall-hooks · review · reconcile · blast · verdict · verdicts · seed · promote · mine`

## MCP tools (14)

`index_repo` · `get_review_context` · `get_blast_radius` · `get_deterministic_findings` · `submit_findings` · `record_outcome` · `reconcile_outcomes` · `get_relevant_knowledge` · `seed_knowledge` · `consolidate_knowledge` · `propose_promotions` · `mine_scan` · `add_pitfalls` · `mine_history`

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
| `PLEX_DATA_DIR` | per-repo data dir (default `''` = centralized `~/.plex/repos/<id>`; `.plex` = in-repo) |
| `PLEX_KNOWLEDGE_DIR` | global knowledge base (default `~/.plex/knowledge`) |

## Status

All milestones complete (M0–M11). `pnpm test` runs the unit (vitest, 51) + integration (tsx, 11) suites; `pnpm test:brain` verifies the PR brain end-to-end under node; `pnpm build` produces node-runnable binaries. Built with TypeScript/Node and pnpm workspaces, fully embedded (Kùzu — no services). See [`docs/milestones/`](docs/milestones/) and the [30-entry decision log](docs/adr/README.md).

## License

[MIT](LICENSE)
