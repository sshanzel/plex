# reviewer

A **local-first, open-source AI code reviewer**. It does not replace your coding agent — it makes whatever agent you already use (Claude Code, Codex) dramatically more rigorous and *unbiased*, by:

- running review in a **fresh context**, separate from whoever wrote the code (no self-review bias, even across rounds);
- grounding the review in a **blast-radius map** of your codebase (git co-change + imports + precise TS edges);
- focusing it with **accumulated review knowledge** that gets sharper over time from your verdicts;
- merging first-principles reasoning, learned pitfalls, and deterministic rules into **one severity- and confidence-ranked stream**.

See [`docs/architecture.md`](docs/architecture.md) for the design and [`docs/adr/README.md`](docs/adr/README.md) for the decision log.

## Architecture at a glance

- **MCP server** — the integration seam. Any agent connects and calls tools to *get* review context and *record* findings/verdicts.
- **Kùzu** (embedded, durable) — N per-repo code graphs + 1 global knowledge graph, joined at `Finding` nodes.
- **FalkorDB** (in-memory, ephemeral) — per-PR "review neighborhood" graphs, also great for live visual debugging.

## Dev

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm mcp        # start the MCP server (stdio)
```

## Status

Built milestone-by-milestone; see [`docs/milestones/`](docs/milestones/) for intent → acceptance → built records.
