# Plex

Plex is a local-first code reviewer that works through the coding agent you already use (Claude Code or Codex). It isn't a new model. It's an MCP server and CLI that make your agent a far more rigorous and unbiased reviewer, and it sharpens the more you use it.

- **Unbiased.** Review runs in a fresh, separate context, so it never anchors on the reasoning of whoever wrote the code, even across several rounds.
- **Grounded.** A blast-radius map of your codebase (git co-change, imports, and precise TypeScript edges) shows what else a change can break, not just the lines in the diff.
- **Compounding.** Review knowledge accumulates both globally (across your repos) and per project, reweighted by your verdicts and learned from your PR review history.
- **Remembers where it bit you.** Every past concern is anchored to the exact code it was about. Touch that code again and Plex surfaces its history — loudest when you're changing something it flagged and you already *fixed* (a regression a stateless linter has no memory to catch). Concerns even propagate along how your code co-changes. This is the difference between a checker and a reviewer with memory ([code-path memory](docs/design/code-path-memory.md)).
- **One stream.** First-principles reasoning, learned pitfalls, and deterministic checks are merged into a single list, ranked by severity, confidence, and blast radius.

The reasoning still comes from the frontier model. Plex's job is to feed it the right context and remember what it learns.

## Why

Copilot review hits usage limits, the Claude solo plan has no review feature, and the agent that wrote the code is a biased reviewer of it. Plex is the unbiased second pair of eyes, running on the subscription you already pay for.

## Quick start

**1. Add the plugin** in Claude Code (once — it then works in every repo you open). This is the reviewer itself: a fresh-context agent, the `/plex:review` command, and the MCP engine it runs on.

```
/plugin marketplace add sshanzel/plugins
/plugin install plex@sshanzel
```

**2. Add an embedding key** (highly recommended). This switches on the part of Plex that *learns*: retrieved pitfalls, semantic matching, and PR-history analysis. See [Embeddings](#embeddings) for the options (Voyage has a free tier).

```bash
npx @sshanzel/plex init
```

It saves the key to `~/.plex/config.json` (you can also create that file yourself) and offers to index the current repo. To seed Plex from your past reviews, run **`/plex:analyze`** in your agent — the fastest way to a useful Plex (see [Bootstrap from your PR history](#bootstrap-from-your-pr-history)). For the few maintenance commands you can run from a terminal, `npm install -g @sshanzel/plex` gives you a plain `plex` command — see [Command-line use](#command-line-use-optional).

**3. Review.** Run **`/plex:review`**, or just say *"review my changes with Plex."* The first review indexes the repo for you, and the graph keeps itself fresh after that.

Plex still reviews without a key, just without the learning layer, and it reminds you once per review until you add one.

### Using Codex

Codex installs the same plugin from its own marketplace. Codex has no agent type, so the reviewer ships as a `plex-review` skill:

```
codex plugin marketplace add sshanzel/plex
```

Then run the `plex-review` skill (through `/skills` or `$plex-review`). Everything else works the same way.

> Updating: the plugin updates with a marketplace pull. Claude: `/plugin marketplace update` then `/reload-plugins`. Codex: `codex plugin marketplace upgrade`. The engine updates on its own through npm.

## Large repos

The first review indexes the repo for you, which walks the git history. On a large repo that can take a minute, so the first review is slower than the rest. To get that out of the way up front, build the graph before you review, from inside the repo:

```bash
npx @sshanzel/plex index
```

After that, reviews use the cached graph and refresh only what changed. (If you installed the CLI globally, it's just `plex index`.)

## Embeddings

Plex works without an embedding provider, but a key is what turns on the layer that *learns*. It is the difference between a sharp one-shot reviewer and one that compounds:

- **Without a key:** fresh-context review, the blast-radius map, and deterministic checks. Findings still auto-accept by file/line locality, and stored pitfalls are still retrieved — by keyword match rather than semantically.
- **With a key:** all of that, plus the full knowledge layer. Plex pulls relevant past pitfalls into each review *semantically*, suppresses issues you have already dismissed *by meaning* (so they survive rewording and moved lines), spots changes nobody flagged, and can learn reusable pitfalls from your PR review history. This is the "gets sharper the more you use it" part.

So add one: run `npx @sshanzel/plex init`, create `~/.plex/config.json` yourself, or set the environment variable pair (`PLEX_EMBEDDING_PROVIDER=voyage` + the provider's key, e.g. `VOYAGE_API_KEY` — env overrides the file):

```json
{ "embedding": { "provider": "voyage", "apiKey": "YOUR_KEY" } }
```

Either way it takes effect on the next review, no reload.

**Providers:**

- **Voyage** (recommended). Code-specialized embeddings, and the free tier is plenty to start. It is what I use day to day. Set `voyage` and a `VOYAGE_API_KEY`.
- **OpenAI.** `text-embedding-3-small` is cheap and solid. Set `openai` and `OPENAI_API_KEY`.
- **Gemini.** Set `gemini` and `GEMINI_API_KEY`.
- **Ollama.** Fully local, no key, good for private repos. Set `ollama` (needs Ollama running with an embedding model such as `nomic-embed-text`).

Switching providers later invalidates the stored vectors, since they are not comparable across models (ADR-13). If you change, remove `~/.plex/knowledge` and re-analyze.

## Bootstrap from your PR history

Plex gets sharper as you review, but you can give it a head start. Run **`/plex:analyze`** in your agent (e.g. `/plex:analyze --oldest --limit 50`) and it pulls your past PR review comments, clusters the recurring themes, and distills them into pitfalls anchored to your code — so the reviewer is useful from day one instead of learning from scratch.

Your connected agent does the distilling (no API key, no separate LLM), on the repo your terminal is in. It needs the GitHub CLI (`gh`) authenticated and an embedding key set (see [Embeddings](#embeddings)). It's incremental: re-run to keep working through your history — `--oldest` goes chronologically from your first PRs, drop it for your most recent, `--limit <n>` bounds a run.

## Command-line use (optional)

You do not need a terminal CLI for normal use: the plugin runs the reviewer, `/plex:analyze` seeds knowledge, and `plex init` sets your key. For the handful of maintenance commands you can run yourself — `index`, `serve` (the visualization UI), `sweep` — see **[docs/cli.md](docs/cli.md)**.

## How it works

```
 diff (local or gh PR)
        │
        ▼  Plex MCP server (fresh, unbiased) assembles the grounding:
   blast radius (Kùzu code graph)  ·  deterministic checks  ·  relevant pitfalls
        │
        ▼  get_review_context
   your agent reasons (first-principles and grounded)
        │
        ▼  submit_findings  →  merge · dedup · rank · triage (severity × confidence × blast)
        │                       └─ (PR, opt-in) post the stream back as one GitHub review
        ▼  record_outcome (accept / reject / waive / acknowledge)  →  knowledge sharpens
```

**Three sources, one stream.** First-principles reasoning (the agent), knowledge-grounded findings (retrieved pitfalls), and deterministic checks (built-in TypeScript-AST rules). Prevalence is read by severity: a common *style* is treated as a convention and demoted, while a common *bug* is treated as systemic and escalated as a migration.

**Two layers of knowledge.** The global layer holds universal pitfalls and your review style, learned across all your repos and reweighted by outcomes; it applies everywhere. The per-project layer holds that repo's code graph and co-change coupling and its repo-scoped pitfalls; it tailors the review to one codebase.

**Closing the loop on a PR (opt-in).** Turn on `autoComment` and a PR review posts the ranked stream as one GitHub review: inline comments on the changed lines, plus a summary for coupled and note findings, deduped across rounds. **`/pr-master:respond`** then works through it (you decide each one) and records the outcomes back into the knowledge base (ADR-34). That command comes from a second plugin in the same marketplace, installed separately when you want it: `/plugin install pr-master@sshanzel`.

**Review-history analysis.** Plex turns your PR-review history into pitfalls. Run **`/plex:analyze`** and it pulls review comments through `gh`, denoises them, clusters similar ones, and your connected agent distills each cluster — deciding what's worth keeping and whether it belongs to the global or the per-project layer (`analyze_scan` then `add_pitfalls`, on your subscription, no API key). It's incremental: a per-repo cursor only reads new PRs.

## MCP tools

`index_repo` · `get_review_context` · `get_blast_radius` · `get_deterministic_findings` · `submit_findings` · `record_outcome` · `reconcile_outcomes` · `refresh_outcomes` · `get_relevant_knowledge` · `consolidate_knowledge` · `analyze_scan` · `add_pitfalls` · `sweep_outcomes` · `doctor`

## Architecture

**MCP server and CLI** are the integration seam: the agent brings the LLM, and Plex brings the grounding and the memory.

**Kùzu** (embedded, MIT) holds the durable per-repo code graph: symbols, imports, co-change, and precise alias edges. It's an embedded engine with no service to run (ADR-30), opened only to map a change's blast radius. The graph is built once and refreshed incrementally, and reviews index or refresh it on first use or when it drifts. The per-PR brain — rounds, findings, verdicts, comments, and the *changed-without-feedback* signal — is kept separately as a durable, append-only JSONL log per review target, keyed to the base repo so it survives `git worktree remove` (ADR-46). Neither needs a service running.

**Knowledge base** is JSON-backed pitfalls and incidents with embeddings, behind a pluggable and optional embedding provider (Voyage, OpenAI, Gemini, or Ollama). Waivers suppress the same issue across rounds *by meaning*, so they survive line drift and rewording.

See [`docs/architecture.md`](docs/architecture.md) and the decision log in [`docs/adr/README.md`](docs/adr/README.md).

## Configuration

Everything here is optional. Set it once with `plex init` (saved to `~/.plex/config.json`), or as an environment variable, which overrides the file.

| Variable | Purpose |
|---|---|
| `PLEX_EMBEDDING_PROVIDER` | Semantic knowledge and brain signals: `voyage`, `openai`, `gemini`, or `ollama`. `none` turns it off; `fake` is for tests only. |
| *(provider key)* | `VOYAGE_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`. Ollama needs none. |
| `PLEX_DATA_DIR` | Per-repo data directory. Default is centralized at `~/.plex/repos/<id>`; set `.plex` to keep it in the repo, where it self-ignores. |
| `PLEX_KNOWLEDGE_DIR` | Global knowledge base. Default `~/.plex/knowledge`. |
| `PLEX_AUTO_COMMENT` | Post a PR review's findings back to the GitHub PR. Off by default. Set `PLEX_AUTO_COMMENT_SKIP_NITS=true` to leave nits out; otherwise nits are posted too. |

## License

[MIT](LICENSE)
