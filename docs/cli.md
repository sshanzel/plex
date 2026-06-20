# Plex CLI

You do not need the CLI for normal use. The plugin runs the reviewer (agent + MCP), `/plex:analyze` seeds knowledge from your PR history, and `plex init` sets your embedding key. The CLI is the same engine for the few jobs that aren't the review itself: setup, building the code graph, the visualization UI, and background maintenance.

There is no `plex review` or `plex analyze` command. The review and the history analysis both run through your agent, in its own fresh context (that is the whole point), so the CLI never does the reasoning — use **`/plex:review`** and **`/plex:analyze`**.

## Running it

Two ways, same engine. Run them from inside your repo; every command defaults to the current git repo.

- **No install.** Prefix any command with `npx @sshanzel/plex`. npx fetches the package once and caches it:

  ```bash
  npx @sshanzel/plex index
  ```

- **Global install (for a bare `plex`).** If you run these often, put it on your PATH:

  ```bash
  npm install -g @sshanzel/plex
  plex index
  ```

The examples below use the bare `plex`. Without a global install, prefix with `npx @sshanzel/plex` (e.g. `npx @sshanzel/plex serve`).

## Commands

| Command | What it does |
|---|---|
| `plex init` | Interactive setup: set the embedding key, then offer to index the current repo. The most common reason to reach for the CLI. |
| `plex index [--incremental]` | Build or refresh the code graph. `--incremental` re-reads only the files that changed. (Reviews auto-index on first use and refresh on drift, so you rarely need this by hand.) |
| `plex serve [--port N] [--stop] [--status]` | Start the local web UI to explore the code graph, PR brain & knowledge (`http://127.0.0.1:2288`). On-demand; opens Kùzu per request, so it never blocks a review. |
| `plex sweep` | Run background maintenance once: close landed review loops, refresh main's graph, and consolidate knowledge decay (ADR-43). Normally auto-spawned by a review; this is the manual trigger. |

Everything else happens through your agent: it reviews with `/plex:review`, seeds knowledge with `/plex:analyze`, and calls the MCP tools (`index_repo`, `analyze_scan` / `add_pitfalls`, `reconcile_outcomes`, `record_outcome`, `consolidate_knowledge`, `doctor`, …) directly during a review — so you don't touch the CLI for them.

## Storage

Per-repo data lives outside your repo, at `~/.plex/repos/<id>/`, so there is nothing to add to `.gitignore`. The global knowledge base is at `~/.plex/knowledge/`, and your key and settings are in `~/.plex/config.json`. See the [Embeddings section of the README](../README.md#embeddings) for providers and the switch-provider caveat.

## From source (contributors)

```bash
pnpm install && pnpm build         # builds dist/plex.js and dist/plex-mcp.js (run under node; ADR-19)
node dist/plex.js index            # build the graph for the current repo
node dist/plex.js serve            # open the visualization UI
```

**Heads-up:** don't test the *published* package with `npx @sshanzel/plex …` from inside this repo. The repo's own `package.json` is named `@sshanzel/plex`, so npx resolves to the local copy (whose bin isn't linked) and you get `sh: plex: command not found`. Use `node dist/plex.js …` here, or run the npx command from any other directory.

See [`AGENTS.md`](../AGENTS.md) for the full contributor workflow.
