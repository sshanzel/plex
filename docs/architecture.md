# Architecture

> Living document. Updated as milestones land. Decisions are recorded in [`adr/`](adr/README.md); per-milestone intent→built records live in [`milestones/`](milestones/).

## Problem

Copilot review hits usage limits; the Claude solo plan has no review feature; and the agent that *wrote* the code is a biased reviewer of it — especially across rounds, where it anchors on its own prior reasoning. We want a **local-first, fully embedded** reviewer that is **unbiased**, **rigorous** (catches real/potential bugs, improvements, and nits — not only known patterns), and **learns over time**.

## The core idea

Plex is **not** another LLM that reviews code. It is an **MCP server + CLI** that any coding agent (Claude Code, Codex) connects to. The agent brings the LLM; Plex brings **grounding + memory** and runs the review in a *fresh* context, separate from whoever wrote the code. It:

1. runs in a **fresh process** (removes self-review bias — the reviewer sees *facts*, never the author's chain-of-thought, ADR-02);
2. hands the agent a **blast-radius map** of what the change touches and is coupled to;
3. focuses it with **accumulated review knowledge** + the project's `plex.md` + the change's stated intent;
4. records what happens in a **per-PR brain** so multi-round reviews stay consistent and outcomes are learned **autonomously**;
5. merges the agent's findings with **deterministic** findings into one **severity/confidence-ranked** stream.

Everything is **embedded** (Kùzu + JSON files) — no Docker, no services (ADR-30).

## The stores — two Kùzu graphs + one global JSON memory + steering files

| Store | Tech / location | Scope | Holds | Why this tech |
|---|---|---|---|---|
| **Code graph** ("the map") | Kùzu · `~/.plex/repos/<id>/graph.kuzu` | per-repo, durable | `File`/`Symbol` nodes; `Imports`, `Refs` (precise TS alias-resolved), `Declares`, `CoChange` (git, weighted+decayed) edges | needs **multi-hop** traversal (blast radius = follow edges) → a real graph DB |
| **PR brain** ("working memory") | Kùzu · `~/.plex/repos/<id>/brain.kuzu` | per-repo, per **target** | `Round`/`Finding`/`Verdict`/`Comment` nodes keyed by `<repo>__pr_N` | structured per-PR state queried by target; embedded, same engine as the graph |
| **Knowledge base** ("the learning") | JSON/JSONL · `~/.plex/knowledge/` | **global** (cross-repo) | `Pitfall`s (+embeddings, confidence) ← `Incident`s (provenance); `scope: global \| repo` | needs **semantic** retrieval, not multi-hop → flat store + embeddings (ADR-18) |
| **Steering / logs** | markdown + JSONL · in-repo / `~/.plex/repos/<id>/` | per-repo | `plex.md` (human rules), `verdicts.jsonl` (waivers), `log/events.jsonl` (attribution) | human-editable + greppable |

> **Semantic vs. multi-hop.** *Semantic* finds things by **meaning** (embed → cosine similarity; a flat, one-shot lookup — no relationships). *Multi-hop* finds things by **connection** (traverse edges N steps). The knowledge base is semantic ("what lesson *means* like this code?") so a JSON+embedding store suffices; the code graph is multi-hop ("what is *coupled* to this file?") so it's Kùzu. That's why they use different tech.

> **The "brain" is two memories, not one.** The **PR brain** is *this PR* (rounds, findings, comments, verdicts — transient working memory). The **knowledge base** is *every PR, forever* (distilled pitfalls — the durable, cross-project learning, where "gets smarter over time" actually lives). Project-specific lessons live in the same global knowledge with `scope: repo` (personalization) and are retrieved only for their origin repo (ADR-21).

## Data flow (one `get_review_context`)

```
            ┌──────────────────── Plex MCP server (fresh, unbiased; embedded Kùzu) ───────────────────┐
 diff  ──►  │ ingest→normalize    code graph (Kùzu)         knowledge (JSON+embed)     deterministic   │
 (local /   │  (diff vs base)  ──►  BFS blast radius   ──►   relevant pitfalls (sem.) ─► built-in/ext   │
  gh PR)    │  + change context    (multi-hop over edges)                                              │
            │                                                                                          │
            │  PR brain (Kùzu): record round · ingest PR comments · changed-without-feedback ·         │
            │                    auto-accept fixes from prior rounds                                   │
            └──────────────────────────────────┬───────────────────────────────────────────────────-─┘
                                                ▼  get_review_context  (assembled bundle)
                                     connected agent reasons (first-principles + grounded)
                                                ▼  submit_findings
                            merge / dedup / rank / triage  ──►  ranked findings to the user, then STOP
                                                ▼  (later, autonomously)
                       fix on re-review → accept · explicit dismissal → reject · → reweight knowledge
```

## Blast radius is *computed*, never *stored*

The blast radius is **derived** from `(code graph + diff)`, not persisted:

1. the diff names the changed files/symbols → map to code-graph nodes;
2. **BFS-expand over `CoChange` + `Imports` + `Refs` edges** (hop-decayed score) → coupled files, tagged by *why* they're in the neighborhood (provenance).

It is recomputed every review because it's **cheap (local Kùzu queries — zero tokens; tokens are spent only by the agent reasoning) and always correct** as the PR evolves. Caching it would add staleness/invalidation bugs for no real savings. The principle: **persist what you can't recompute** (the expensive-once code graph; the non-derivable observations in the brain), **recompute what you can** (the blast radius).

*(Historical note: the retired FalkorDB layer only ever received a **copy** of the computed neighborhood for a Browser picture — it never computed it. Removing FalkorDB, ADR-30, changed nothing about blast radius.)*

**New files in a PR.** A committed new file is picked up by the **auto-refresh** (incremental index before each review): it's parsed, its `Imports`/`Refs` are resolved by the TS compiler, and it enters the graph — so blast radius expands from/into it. Co-change is *inherently* empty for a brand-new file (no git history yet). Limitation: for a **remote PR whose branch isn't checked out locally**, the new files aren't on disk to index, so their blast radius is thin — the agent compensates by reading the diff content directly (have CI/the responder `gh pr checkout` for airtight coverage).

## Code understanding is layered (ADR-06)

| Layer | Source | Always on? | Notes |
|---|---|---|---|
| Agnostic spine | git **co-change** + **imports** | yes | language-free; co-change catches runtime coupling (DI/injected services) that static analysis misses |
| Precise enrichment | **TS compiler API** ref edges | TS/JS repos | resolves tsconfig **path aliases**, baseUrl, index files; other languages plug in via tree-sitter later (ADR-15) |

Blast radius ≈ **coupling**, not a precise call graph. Edges are unioned and tagged by `provenance` + `weight`. The graph is built once and **refreshed incrementally** (TS *and* co-change — ADR-25/26); a review **auto-indexes** on first use and **auto-refreshes** on drift, both in an isolated child process (ADR-17/30).

## Findings: three sources, one stream (ADR-03, ADR-04)

- **first-principles** (the spine — novel bugs, always on, from the agent's reasoning),
- **knowledge-grounded** (recurring pitfalls retrieved semantically from the knowledge base),
- **deterministic** (built-in TS-AST checks + Semgrep/ast-grep).

Ranked by `signal = severity × confidence × deviation-from-norm × blastRadius − waiverWeight`. Severity and confidence are **independent axes** (a "potential bug" = `bug` severity + low confidence). Cross-source agreement boosts confidence. Prevalence is read **by severity**: common *style* → convention (demote); common *bug* → systemic (escalate as a migration). Waivers suppress the same issue across rounds **by meaning** (semantic — survives line drift / rewording, ADR-27).

## The learning loop (per-PR observations → global memory)

The review is **autonomous** (ADR-28): the agent submits findings and stops — it never prompts for verdicts. Outcomes are observed from real behavior and compound into the global knowledge:

- a finding **addressed by a later change** → auto-`accept` on the next review (or via `reconcile`); an **explicit dismissal** → `reject` (responder); an `awareness` flag confirmed intentional → **`acknowledge`** (M12, no down-weight); **silence** → nothing.
- accepted findings become **Incidents** → reweight **Pitfall** confidence (`consolidate_knowledge`); mining distills recurring PR-comment patterns into new pitfalls.
- **closing the loop on a PR (ADR-34, opt-in `autoComment`):** reviewing a PR posts the ranked stream back as one GitHub review (inline + summary, deduped per round); the `pr-review-responder` skill triages it and records the outcomes above — so the loop runs on the PR itself, not just the terminal.
- so a lesson learned on one PR becomes a **global pitfall** retrieved on *future* reviews everywhere. `plex.md` ⇄ knowledge ⇄ Semgrep/ast-grep promotion (ADR-09) keeps a human-editable surface and a path to deterministic rules.

## Knowledge ⇄ markdown (ADR-09, ADR-10)

`plex.md` is the human-editable surface — both **input** (cold-start seed, hard overrides) and **output** (proposed promotions). The knowledge base is the learned engine; high-confidence *codifiable* lessons promote further into rules. Verdicts (scoped + semantic waivers) reweight confidence; confirmed novel bugs become `Incident`s that can distill into new `Pitfall`s.

## Packages

| Package | Responsibility | Status |
|---|---|---|
| `core` | shared types, config, provider interfaces | ✅ |
| `ingest` | diff adapters (local git, gh PR) → normalized diff; head SHA + inter-round diff helpers | ✅ |
| `code-graph` | Kùzu per-repo graph: symbols/imports/co-change + precise alias edges; incremental update | ✅ |
| `neighborhood` | diff→symbols→blast-radius BFS over the code graph (multi-hop) | ✅ |
| `deterministic` | built-in TS-AST checks + Semgrep/ast-grep detection | ✅ |
| `findings` | merge/dedup/rank/triage; round-delta classifier; semantic waiver matcher | ✅ |
| `knowledge` | embeddings, JSON store, semantic retrieval, seeding, promotion (ADR-18) | ✅ |
| `mining` | gh PR-history → denoise → cluster → distill → pitfalls; incremental cursor (ADR-11/20) | ✅ |
| `engine` | orchestration: index, assemble context, **Kùzu PR brain**, rank, verdicts, knowledge, reconcile, setup | ✅ |
| `mcp-server` | the 14-tool MCP surface | ✅ |
| `cli` | `init · doctor · index · install-hooks · review · reconcile · blast · verdict · seed · promote · mine` | ✅ |

> **Embedded, no services (ADR-30):** the brain is Kùzu, not FalkorDB — no Docker. Per-repo data lives outside the repo at `~/.plex/repos/<id>/`. Embeddings are **optional** (they add semantic knowledge + the semantic review signals). Build/run: `pnpm build` then `pnpm start:mcp` (node — stable with the Kùzu addon; ADR-17/19). The multi-repo workspace is intentionally **out of scope**.
