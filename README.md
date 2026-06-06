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

```bash
pnpm install
pnpm build                         # → dist/plex.js, dist/plex-mcp.js  (run under node; ADR-19)

# index a repo (build its code graph)
node dist/plex.js index /path/to/repo

# review changes
node dist/plex.js review /path/to/repo --staged          # or --branch main, --pr 123, --html nb.html

# build knowledge from PR history (distilled via your claude subscription)
node dist/plex.js mine /path/to/repo

# seed project guidance, then teach it from verdicts
node dist/plex.js seed /path/to/repo                     # from <repo>/plex.md
node dist/plex.js verdict <id> accept --file src/x.ts
node dist/plex.js promote /path/to/repo
```

### Use it from Claude Code (MCP)

```bash
claude mcp add plex -- node /abs/path/to/dist/plex-mcp.js
```
Then, inside a target repo, ask your agent to *"review my staged changes with Plex."* A ready-made review subagent is included at [`.claude/agents/`](.) — drop one into any repo.

## CLI

`plex index · review · blast · verdict · verdicts · seed · promote · mine`

## MCP tools (13)

`index_repo` · `get_review_context` · `get_blast_radius` · `get_deterministic_findings` · `submit_findings` · `record_outcome` · `get_relevant_knowledge` · `seed_knowledge` · `consolidate_knowledge` · `propose_promotions` · `mine_scan` · `add_pitfalls` · `mine_history`

## Architecture

- **MCP server + CLI** — the integration seam; the agent brings the LLM, Plex brings grounding + memory.
- **Kùzu** (embedded, MIT) — one durable code graph per repo (symbols, imports, co-change, precise alias edges).
- **Knowledge base** — JSON-backed pitfalls + incidents with embeddings; pluggable embedding provider (Voyage / OpenAI / Ollama / offline).
- **FalkorDB** (optional, in-memory) — ephemeral per-PR "review neighborhood" graphs for live visual debugging.

See [`docs/architecture.md`](docs/architecture.md) and the decision log in [`docs/adr/README.md`](docs/adr/README.md).

## Configuration

Environment variables (all optional):

| Var | Purpose |
|---|---|
| `PLEX_DATA_DIR` | per-repo data dir (default `.plex`) |
| `PLEX_KNOWLEDGE_DIR` | global knowledge base (default `~/.plex/knowledge`) |
| `PLEX_EMBEDDING_PROVIDER` | `voyage` \| `openai` \| `ollama` \| `fake` |
| `PLEX_LLM_PROVIDER` | mining distiller: `claude-cli` (default) \| `anthropic` \| `openai` |
| `PLEX_FALKORDB_URL` | enable the ephemeral viz layer, e.g. `redis://localhost:6380` |

## Status

`pnpm test` runs the unit (vitest) + integration (tsx) suites; `pnpm build` produces node-runnable binaries. Built with TypeScript/Node and pnpm workspaces.

## License

[MIT](LICENSE)
