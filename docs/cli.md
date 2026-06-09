# Plex CLI

You do not need the CLI for normal use. The plugin runs the reviewer (agent + MCP), and `plex init` sets your embedding key. The CLI is the same engine for the jobs that aren't the review itself: building the code graph, growing the knowledge base, and inspecting state, by hand or in CI.

There is no `plex review` command. A review always runs through the agent, in its own fresh context (that is the whole point), so the CLI never does the reasoning.

## Running it

Two ways, same engine. Run them from inside your repo; every command defaults to the current git repo.

- **Global install (recommended).** Put `plex` on your PATH once, then use plain commands:

  ```bash
  npm install -g @sshanzel/plex
  plex doctor
  ```

- **No install.** Use npx, but be explicit. This package ships two binaries (`plex` and `plex-mcp`), so a bare `npx @sshanzel/plex …` cannot pick one on a fresh machine (you will see `sh: plex: command not found`). Name the package and the binary:

  ```bash
  npx -p @sshanzel/plex plex doctor
  ```

The examples below use the bare `plex`. If you skipped the global install, replace `plex` with `npx -p @sshanzel/plex plex`.

## Commands

| Command | What it does |
|---|---|
| `plex init` | Interactive setup: set the embedding key, then offer to index the current repo. The most common reason to reach for the CLI. |
| `plex index [--incremental]` | Build or refresh the code graph. `--incremental` re-reads only the files that changed. (Reviews auto-index on first use and refresh on drift, so you rarely need this by hand.) |
| `plex mine [--oldest] [--limit N] [--threshold 0..1]` | Turn this repo's PR-review history into pitfalls. Runs on your `claude` subscription. `--oldest` walks from PR #1 up. |
| `plex seed [--file plex.md]` | Seed pitfalls from a markdown file. |
| `plex promote` | Propose promoting high-confidence pitfalls into `plex.md` or rules. |
| `plex reconcile` | Auto-accept earlier findings that your pushed commits have since fixed. |
| `plex eval` | Offline check of how well the ranking matches the outcomes you recorded (nDCG), plus a verdict on whether there is enough data to tune. Reports only; it never changes anything. |
| `plex blast --files a.ts,b.ts` | Print the blast radius (coupled files) for the given files. |
| `plex verdict <id> <accept\|reject\|waive\|acknowledge>` | Record a verdict on a finding. |
| `plex verdicts` | List the verdicts recorded for this repo. |
| `plex doctor` | Show the embedding and graph status, and whether a newer build is waiting on disk. |

Most of these are also available to your agent as MCP tools (`index_repo`, `mine_scan` / `add_pitfalls`, `seed_knowledge`, `reconcile_outcomes`, `record_outcome`, `propose_promotions`, `doctor`), so the agent can do them during a review without you touching the CLI. The CLI is mainly for CI, scripting, or running something by hand.

## Storage

Per-repo data lives outside your repo, at `~/.plex/repos/<id>/`, so there is nothing to add to `.gitignore`. The global knowledge base is at `~/.plex/knowledge/`, and your key and settings are in `~/.plex/config.json`. See the [Embeddings section of the README](../README.md#embeddings) for providers and the switch-provider caveat.

## From source (contributors)

```bash
pnpm install && pnpm build         # builds dist/plex.js and dist/plex-mcp.js (run under node; ADR-19)
node dist/plex.js index            # build the graph for the current repo
node dist/plex.js doctor           # check status
```

See [`AGENTS.md`](../AGENTS.md) for the full contributor workflow.
