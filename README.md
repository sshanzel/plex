# Plex

Plex is a local-first code reviewer that works through the coding agent you already use (Claude Code or Codex). It isn't a new model. It's an MCP server and CLI that make your agent a far more rigorous and unbiased reviewer, and it sharpens the more you use it.

- **Unbiased.** Review runs in a fresh, separate context, so it never anchors on the reasoning of whoever wrote the code, even across several rounds.
- **Grounded.** A blast-radius map of your codebase (git co-change, imports, and precise TypeScript edges) shows what else a change can break, not just the lines in the diff.
- **Compounding.** Review knowledge accumulates both globally (across your repos) and per project, reweighted by your verdicts and mined from your PR history.
- **One stream.** First-principles reasoning, learned pitfalls, and deterministic checks are merged into a single list, ranked by severity, confidence, and blast radius.

The reasoning still comes from the frontier model. Plex's job is to feed it the right context and remember what it learns.

## Why

Copilot review hits usage limits, the Claude solo plan has no review feature, and the agent that wrote the code is a biased reviewer of it. Plex is the unbiased second pair of eyes, running on the subscription you already pay for.

## Quick start

Install the engine, add the plugin, then set it up in your repo.

**1. Install Plex** (the engine):

```bash
npm install -g @sshanzel/plex
```

**2. Add the plugin** in Claude Code. The plugin is the reviewer itself: a fresh-context agent, the `/plex:review` command, and the MCP server it runs on (bundled with the plugin, so there's nothing to register by hand).

```
/plugin marketplace add sshanzel/plugins
/plugin install plex@sshanzel
```

**3. Open the repo** you want reviewed:

```bash
cd your-repo
```

**4. Set it up** for that repo:

```bash
plex init
```

`init` asks for an optional embedding key (it powers the knowledge base and the semantic signals, the parts that learn across reviews) and then offers to index the repo.

That's the whole setup. Run **`/plex:review`** in Claude Code, or just say *"review my changes with Plex."* The first review indexes the repo for you, and the code graph keeps itself fresh as the repo changes.

### Using Codex

Codex installs the same plugin from its own marketplace. Codex has no agent type, so the reviewer ships as a `plex-review` skill, alongside the `plex-parallel-review` orchestrator:

```
codex plugin marketplace add sshanzel/plex
```

Then run the `plex-review` skill (through `/skills` or `$plex-review`). Everything else works the same way.

> Updating: the plugin updates with a marketplace pull. Claude: `/plugin marketplace update` then `/reload-plugins`. Codex: `codex plugin marketplace upgrade`. The engine updates on its own through npm.

## CLI and maintenance

The plugin is the reviewer. The CLI is the same engine for the jobs that aren't the review itself: setup, building the code graph, and growing the knowledge base. There is no `plex review`, because a review always runs through the agent in its own context. Run any command from inside the repo; they default to the current git repo.

| Command | What it does |
|---|---|
| `plex init` | Interactive setup: optional embedding key, then offer to index the current repo. |
| `plex index [--incremental]` | Build or refresh the code graph. `--incremental` re-reads only the files that changed. |
| `plex mine [--oldest] [--limit N] [--threshold 0..1]` | Turn this repo's PR-review history into pitfalls. Runs on your `claude` subscription. |
| `plex seed [--file plex.md]` | Seed pitfalls from a markdown file. |
| `plex promote` | Propose promoting high-confidence pitfalls into `plex.md` or rules. |
| `plex reconcile` | Auto-accept earlier findings that your pushed commits have since fixed. |
| `plex eval` | Offline check of how well the ranking matches the outcomes you recorded (nDCG). Reports only; it never changes anything. |
| `plex blast --files a.ts,b.ts` | Print the blast radius (coupled files) for the given files. |
| `plex verdict <id> <accept\|reject\|waive\|acknowledge>` | Record a verdict on a finding. |
| `plex verdicts` | List the verdicts recorded for this repo. |
| `plex doctor` | Show the embedding and graph status, and whether a newer build is waiting on disk. |

Per-repo data lives outside your repo, at `~/.plex/repos/<id>/`, so there's nothing to add to `.gitignore`. If you switch embedding providers the stored vectors no longer match (ADR-13), so remove `~/.plex/knowledge` and re-seed or re-mine.

### From source (contributors)

```bash
pnpm install && pnpm build         # builds dist/plex.js and dist/plex-mcp.js (run under node; ADR-19)
node dist/plex.js index            # build the graph for the current repo
```

## How it works

```
 diff (local or gh PR)
        │
        ▼  Plex MCP server (fresh, unbiased) assembles the grounding:
   blast radius (Kùzu code graph)  ·  deterministic checks  ·  relevant pitfalls  ·  plex.md
        │
        ▼  get_review_context
   your agent reasons (first-principles and grounded)
        │
        ▼  submit_findings  →  merge · dedup · rank · triage (severity × confidence × blast)
        │                       └─ (PR, opt-in) post the stream back as one GitHub review
        ▼  record_outcome (accept / reject / waive / acknowledge)  →  knowledge sharpens
```

**Three sources, one stream.** First-principles reasoning (the agent), knowledge-grounded findings (retrieved pitfalls), and deterministic checks (built-in TypeScript-AST checks, plus optional Semgrep or ast-grep). Prevalence is read by severity: a common *style* is treated as a convention and demoted, while a common *bug* is treated as systemic and escalated as a migration.

**Two layers of knowledge.** The global layer holds universal pitfalls and your review style, mined across all your repos and reweighted by outcomes; it applies everywhere. The per-project layer holds that repo's code graph and co-change coupling, its repo-scoped pitfalls, and its `plex.md` instructions; it tailors the review to one codebase.

**Closing the loop on a PR (opt-in).** Turn on `autoComment` and a PR review posts the ranked stream as one GitHub review: inline comments on the changed lines, plus a summary for coupled and awareness findings, deduped across rounds. **`/pr-master:respond`** then works through it (you decide each one) and records the outcomes back into the knowledge base (ADR-34).

**Mining.** Plex turns PR-review history into pitfalls. It pulls review comments through `gh`, denoises them, clusters similar ones, and an LLM distills each cluster, deciding what's worth keeping and whether it belongs to the global or the per-project layer. Distillation runs on your subscription, through either the connected agent (`mine_scan` then `add_pitfalls`) or the local `claude` CLI (`plex mine`). It's incremental: a per-repo cursor only reads new PRs.

## MCP tools

`index_repo` · `get_review_context` · `get_blast_radius` · `get_deterministic_findings` · `submit_findings` · `record_outcome` · `reconcile_outcomes` · `get_relevant_knowledge` · `seed_knowledge` · `consolidate_knowledge` · `propose_promotions` · `mine_scan` · `add_pitfalls` · `mine_history` · `doctor`

## Architecture

**MCP server and CLI** are the integration seam: the agent brings the LLM, and Plex brings the grounding and the memory.

**Kùzu** (embedded, MIT) holds the durable per-repo code graph (symbols, imports, co-change, and precise alias edges) and the per-PR brain (rounds, findings, verdicts, comments, and the *changed-without-feedback* signal). It's one embedded engine with no service to run (ADR-30). The graph is built once and refreshed incrementally, and reviews index or refresh it on first use or when it drifts.

**Knowledge base** is JSON-backed pitfalls and incidents with embeddings, behind a pluggable and optional embedding provider (Voyage, OpenAI, Gemini, or Ollama). Waivers suppress the same issue across rounds *by meaning*, so they survive line drift and rewording.

See [`docs/architecture.md`](docs/architecture.md) and the decision log in [`docs/adr/README.md`](docs/adr/README.md).

## Configuration

Everything here is optional. Set it once with `plex init` (saved to `~/.plex/config.json`), or as an environment variable, which overrides the file.

| Variable | Purpose |
|---|---|
| `PLEX_EMBEDDING_PROVIDER` | Semantic knowledge and brain signals: `voyage`, `openai`, `gemini`, or `ollama`. `none` turns it off; `fake` is for tests only. |
| *(provider key)* | `VOYAGE_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`. Ollama needs none. |
| `PLEX_LLM_PROVIDER` | Mining distiller: `claude-cli` (default), `anthropic`, or `openai`. |
| `PLEX_DATA_DIR` | Per-repo data directory. Default is centralized at `~/.plex/repos/<id>`; set `.plex` to keep it in the repo, where it self-ignores. |
| `PLEX_KNOWLEDGE_DIR` | Global knowledge base. Default `~/.plex/knowledge`. |
| `PLEX_AUTO_COMMENT` | Post a PR review's findings back to the GitHub PR. Off by default. Set `PLEX_AUTO_COMMENT_SKIP_NITS=true` to leave nits out; otherwise nits are posted too. |

## License

[MIT](LICENSE)
