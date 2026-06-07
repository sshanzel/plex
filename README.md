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

A full (brain-backed) review needs the built binaries, **FalkorDB**, and a real **embedding provider**. A code-graph `index` needs none of these — embeddings + FalkorDB power the *review*, not the index.

```bash
pnpm install
pnpm build                         # → dist/plex.js, dist/plex-mcp.js  (run under node; ADR-19)

# 1. start FalkorDB — the per-PR review brain (required; AOF-persisted)
cp .env.example .env               # ports/paths (FalkorDB on :56379 by default)
pnpm db:up                         # Browser → http://localhost:53000

# 2. choose a real embedding provider + key (the brain + knowledge need it)
export PLEX_FALKORDB_URL=redis://localhost:56379
export PLEX_EMBEDDING_PROVIDER=voyage          # voyage | openai | gemini | ollama
export VOYAGE_API_KEY=...                       # or OPENAI_API_KEY / GEMINI_API_KEY; ollama needs none

# 3. index a repo (full build), and auto-refresh it on pull/checkout/rebase
node dist/plex.js index /path/to/repo
node dist/plex.js install-hooks /path/to/repo
#   later refreshes are O(changed files):  node dist/plex.js index /path/to/repo --incremental

# 4. review changes (brain on with --falkor; auto-refreshes the graph if it drifted)
node dist/plex.js review /path/to/repo --pr 123 --falkor    # or --staged / --branch main / --html nb.html

# build knowledge from PR history (distilled via your claude subscription); seed from <repo>/plex.md
node dist/plex.js mine /path/to/repo
node dist/plex.js seed /path/to/repo
```

> **Heads up:** the plex binaries don't read `.env` (only Docker Compose does) — `export` the vars above, or pass them to the MCP server with `-e` (below). Switching embedding providers invalidates stored vectors (ADR-13): `rm -rf ~/.plex/knowledge` and re-seed/-mine.

### Use it from Claude Code (MCP)

The MCP review flow **requires** FalkorDB + an embedding key, so register them with the server:

```bash
claude mcp add plex \
  -e PLEX_FALKORDB_URL=redis://localhost:56379 \
  -e PLEX_EMBEDDING_PROVIDER=voyage \
  -e VOYAGE_API_KEY=... \
  -- node /abs/path/to/dist/plex-mcp.js
```
Then restart Claude Code and, inside a target repo, ask *"review my changes with Plex."* A ready-made review subagent is included at [`.claude/agents/`](.) — drop one into any repo. (Verify the brain end-to-end any time with `pnpm test:brain`.)

## Supporting services (Docker Compose)

```bash
pnpm db:up               # FalkorDB (required) + Browser → http://localhost:53000  (redis on :56379)
pnpm ui:kuzu             # optional: Kùzu Explorer → http://localhost:58000 (set KUZU_DB_DIR/KUZU_FILE)
pnpm db:down             # add -v to wipe the brain volume for a clean slate
```

The FalkorDB Browser shows each PR's **brain** graph (`<repo>__<target>`: rounds, findings, verdicts, comments, blast radius); Kùzu Explorer browses a repo's durable code graph. `review --html` writes a self-contained Cytoscape view of the blast radius.

## CLI

`plex index [--incremental] · install-hooks · uninstall-hooks · review · reconcile · blast · verdict · verdicts · seed · promote · mine`

## MCP tools (14)

`index_repo` · `get_review_context` · `get_blast_radius` · `get_deterministic_findings` · `submit_findings` · `record_outcome` · `reconcile_outcomes` · `get_relevant_knowledge` · `seed_knowledge` · `consolidate_knowledge` · `propose_promotions` · `mine_scan` · `add_pitfalls` · `mine_history`

## Architecture

- **MCP server + CLI** — the integration seam; the agent brings the LLM, Plex brings grounding + memory.
- **Kùzu** (embedded, MIT) — one durable code graph per repo (symbols, imports, co-change, precise alias edges). Built once, refreshed incrementally (TS + co-change); reviews auto-refresh it when it has drifted behind HEAD.
- **Knowledge base** — JSON-backed pitfalls + incidents with embeddings; pluggable embedding provider (Voyage / OpenAI / Gemini / Ollama). Waivers suppress the same issue across rounds *by meaning* (semantic), surviving line drift / rewording.
- **FalkorDB** (required for the review brain, in-memory + AOF) — the per-PR "brain": rounds, findings, verdicts, PR comments, blast radius, and the embedding-based *changed-without-feedback* signal. Inspectable live in the Browser.

See [`docs/architecture.md`](docs/architecture.md) and the decision log in [`docs/adr/README.md`](docs/adr/README.md).

## Configuration

Environment variables (all optional):

The plex binaries read these from the **process env** (not `.env` — export them, or pass via `claude mcp add -e`):

| Var | Purpose |
|---|---|
| `PLEX_FALKORDB_URL` | FalkorDB for the review brain — **required** for `review --falkor` / the MCP flow (e.g. `redis://localhost:56379`) |
| `PLEX_EMBEDDING_PROVIDER` | **required** for the brain + knowledge: `voyage` \| `openai` \| `gemini` \| `ollama` (`none` disables; `fake` is test-only) |
| *(provider key)* | `VOYAGE_API_KEY` \| `OPENAI_API_KEY` \| `GEMINI_API_KEY` (Ollama needs none) |
| `PLEX_LLM_PROVIDER` | mining distiller: `claude-cli` (default) \| `anthropic` \| `openai` |
| `PLEX_DATA_DIR` | per-repo data dir (default `.plex`) |
| `PLEX_KNOWLEDGE_DIR` | global knowledge base (default `~/.plex/knowledge`) |

## Status

All milestones complete (M0–M8). `pnpm test` runs the unit (vitest, 48) + integration (tsx, 10) suites; `pnpm test:brain` verifies the PR brain end-to-end under node; `pnpm build` produces node-runnable binaries. Built with TypeScript/Node and pnpm workspaces. See [`docs/milestones/`](docs/milestones/) and the [27-entry decision log](docs/adr/README.md).

## License

[MIT](LICENSE)
