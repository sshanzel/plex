# Architecture

> Living document. Updated as milestones land. Decisions are recorded in [`adr/`](adr/README.md); per-milestone intent→built records live in [`milestones/`](milestones/).

## Problem

Copilot review hits usage limits; the Claude solo plan has no review feature; and the agent that *wrote* the code is a biased reviewer of it — especially across rounds, where it anchors on its own prior reasoning. We want an open-source, local-first reviewer that is **unbiased**, **rigorous** (catches real/potential bugs, improvements, and nits — not only known patterns), and **learns over time**.

## The core idea

`reviewer` is **not** another LLM that reviews code. It is an **MCP server + orchestration layer** that any coding agent (Claude Code, Codex) connects to. The agent brings the LLM; the server makes that agent dramatically more rigorous by:

1. running in a **fresh process**, separate from whoever authored the code (removes self-review bias);
2. handing the agent a **blast-radius map** of what the change touches and is coupled to;
3. focusing it with **accumulated review knowledge** that sharpens from the user's verdicts;
4. merging the agent's findings with **deterministic** (Semgrep/ast-grep) findings into one **severity- and confidence-ranked** stream.

## Data flow (the review loop)

```
            ┌──────────────────────── reviewer MCP server (fresh, unbiased) ─────────────────────────┐
 diff  ──►  │ ingest → normalize     code-graph (Kùzu)        knowledge (Kùzu)      deterministic     │
 (local /   │   (diff vs base)   ──►   blast radius      ──►   relevant pitfalls ──► Semgrep/ast-grep  │
  gh PR)    │                          ▼ materialize                                                  │
            │                     review neighborhood (FalkorDB, ephemeral pr_<id>)                   │
            └───────────────────────────────────┬──────────────────────────────────────────────────-┘
                                                 ▼  get_review_context  (assembled bundle)
                                      connected agent reasons (first-principles + grounded)
                                                 ▼  submit_findings
                            merge / dedup / rank / triage  ──►  ranked findings to the user
                                                 ▼  record_outcome (accept / reject / waive, scoped)
                                      feedback loop → reweight knowledge; confirmed bugs → incidents
```

## Storage topology — N + 1 (ADR-07)

- **Kùzu** (embedded, MIT, disk-backed) holds the **durable** graphs: one DB per repo (code graph) + one global **knowledge** graph. They join at `Finding` nodes (`Finding ─AT→ CodeLocation`, `Finding ─INSTANCE_OF→ Pitfall`).
- **FalkorDB** (in-memory, multi-graph) holds the per-PR **working-memory graph** `<repo>__pr_<id>` — the "brain of the PR." Today it materializes the blast radius (computed from Kùzu + the diff); M6 (ADR-22/23) extends it to `Round`/`Finding`/`Verdict`/`Comment` nodes that the review flow *queries* for round-aware signals (what changed since last round, and what changed **without feedback**). Durable truth stays in JSON/Kùzu, so the graph is rebuildable; FalkorDB is **optional** (in-process fallback) and never load-bearing for correctness.

> **Blast radius does not come from FalkorDB.** It is computed from the **Kùzu** code graph + the diff: the diff says which existing files/symbols changed, and Kùzu says what is coupled to them (co-change + imports + precise refs). FalkorDB receives the result. That is why a review of a brand-new PR works even with FalkorDB off — and why M6 makes FalkorDB earn its keep instead of being a picture.

## Code understanding is layered (ADR-06)

| Layer | Source | Always on? | Notes |
|---|---|---|---|
| Agnostic spine | git **co-change** + **imports** + embeddings | yes | language-free; co-change catches runtime coupling (DI/injected services) that static analysis misses |
| Precise enrichment | **TS compiler API** call/ref edges | TS/JS repos | accurate references; other languages plug in via tree-sitter later (ADR-15) |

Blast radius ≈ **coupling**, not a precise call graph. Edges are unioned and tagged by `provenance` + `weight`, so the reviewer sees *why* something is in the neighborhood.

## Findings: three sources, one stream (ADR-03, ADR-04)

- **first-principles** (the spine — novel bugs, always on, from the agent's reasoning),
- **knowledge-grounded** (recurring pitfalls retrieved from the knowledge graph),
- **deterministic** (codified rules via Semgrep/ast-grep).

Ranked by `signal = severity × confidence × deviation-from-norm × blastRadius − waiverWeight`. Severity and confidence are **independent axes** (a "potential bug" = `bug` severity + low confidence). Cross-source agreement boosts confidence. Prevalence is interpreted **by severity**: common *style* → convention (demote); common *bug* → systemic (escalate as a migration).

## Knowledge: graph ⇄ markdown (ADR-09, ADR-10)

`plex.md` is the human-editable surface — both **input** (cold-start seed, hard overrides) and **output** (the system proposes promotions). The graph is the learned engine. High-confidence *codifiable* lessons promote further into Semgrep/ast-grep rules. Verdicts (scoped waivers) reweight the graph; confirmed novel bugs become `Incident`s that can distill into new `Pitfall`s.

## Packages

| Package | Responsibility | Status |
|---|---|---|
| `core` | shared types, config, provider interfaces | ✅ |
| `ingest` | diff adapters (local git, gh PR) → normalized diff | ✅ |
| `code-graph` | Kùzu per-repo graph: symbols/imports/co-change + precise alias edges | ✅ |
| `neighborhood` | diff→symbols→blast-radius; ephemeral FalkorDB graph (child process) | ✅ |
| `deterministic` | built-in TS-AST checks + Semgrep/ast-grep detection | ✅ |
| `findings` | merge/dedup/rank/triage (signal, prevalence-by-severity, waivers) | ✅ |
| `knowledge` | embeddings, JSON store, retrieval, seeding, promotion (ADR-18) | ✅ |
| `mining` | gh PR-history → denoise → cluster → distill → pitfalls; incremental cursor (ADR-11/20) | ✅ |
| `engine` | orchestration: index, assemble context, rank, verdicts, knowledge, viz | ✅ |
| `mcp-server` | the 10-tool MCP surface | ✅ |
| `cli` | `index · review · blast · verdict · seed · promote` | ✅ |

> The multi-repo workspace is intentionally **out of scope**. Build/run: `pnpm build` then `pnpm start:mcp` (node — stable with the Kùzu addon; ADR-17/19).
