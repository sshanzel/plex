# Design note — parallel (fan-out) review, gated by a coupling guardrail

**Status:** proposed. The **guardrail + partition** (the make-or-break) is built as a pure, tested primitive (`packages/findings/src/review-plan.ts`); the orchestration (subagent/Workflow fan-out) and the MCP wiring are deferred. Promote to an ADR when the orchestration lands.

## Problem

A single agent reviewing a big diff is slow (a 15-file change took ~10 min). Fanning out subagents could cut wall-clock — **but only sometimes.** Fired on a small or tightly-coupled change, fan-out is *worse*: 5× the tokens to produce a slower, dumber review. The decision of **when to fan out is the whole game.**

## The guardrail (the centerpiece) — decided with ZERO LLM

Plex already has the code graph (co-change + import + precise edges), so it can decide deterministically, before any model runs:

1. **Partition the changed files by coupling** — connected components of the *changed* files under their mutual co-change/import edges (`partitionByCoupling`). Files that move together land in one cluster; independent areas split.
2. **Decide single vs parallel** (`reviewPlan`), conservatively — default to **single** unless fan-out clearly wins:
   - `files < minFiles` (≈6) → **single** (small change; one reviewer is faster).
   - `surface < minSurface` → **single** (low review surface — changed symbols + blast-radius nodes / changed LOC — not worth splitting).
   - `< 2 significant clusters` → **single** (the change is one coupled blob; splitting it would sever the cross-file reasoning that is Plex's whole value).
   - otherwise → **parallel**, into the significant clusters, **capped at `maxAgents`** (merge the smallest clusters together to stay under the cap), with **tiny clusters folded in** (never spawn an agent for a 1-file cluster).
   - every decision carries a human-readable `reason`.

**Partition by COUPLING, never per-file.** Per-file fan-out would destroy the cross-file findings (the blast radius) that are the point. One reviewer per *coupled cluster* keeps cross-file reasoning intact *within* a cluster while parallelizing *across* clusters.

## Architecture (who does what)

Plex has no LLM and can't spawn agents — so:

- **Plex provides:** the partition + guardrail (above, zero-LLM), and the **consolidation** — which mostly already exists: `submit_findings` (via `rankReviewFindings`) merges, dedups, ranks, and triages everything handed to it into one stream and stores it in the PR brain per target.
- **The orchestrator** (a Claude Code subagent fan-out, or a **Workflow** — this is the canonical partition → fan-out → consolidate shape): asks Plex for the plan; if `single`, reviews normally; if `parallel`, spawns one reviewer per unit.
- **Flow:** `get_review_context` once → Plex returns the **review plan** → if parallel, fan out N reviewers (each reasons over its cluster's files + blast radius) → **collect their findings → ONE `submit_findings` call** (Plex consolidates: overlaps collapse, cross-reviewer agreement boosts confidence) → per-cluster verdict rolls up from the triage (block if any `bug`).

## Trade-offs (recorded honestly)

- **Cost scales ~N×** (each reviewer reasons + grounds). The guardrail exists precisely to make sure that N× only happens when wall-clock genuinely improves. Default conservative.
- **Cross-*cluster* findings are the residual risk** — clusters are *weakly* coupled, not zero-coupled, so a change in cluster A can still affect cluster B. Need a final lightweight **consolidation/cross-check pass** (the orchestrator, holding all clusters' findings, looks for inter-cluster interactions) or you've just relocated the blind spot.
- **It's a large-PR feature.** For a typical small PR the guardrail returns `single`, and nothing changes.

## Build slices

1. ✅ **Partition + guardrail** — pure, tested (`partitionByCoupling`, `reviewPlan`). The make-or-break logic, decided from graph data with no LLM.
2. **Wire into `get_review_context`** — fetch the changed files' mutual coupling from the graph, compute the plan, return it (a "review plan": strategy + units + reason). Tunable thresholds in config (like `clusterThreshold`).
3. **Orchestrator** — a Workflow (or subagent fan-out) that obeys the plan: single → one reviewer; parallel → one reviewer per unit → one consolidating `submit_findings` → cross-cluster check → per-cluster verdict.
4. **Verdict roll-up** — derive ship/block per cluster from the consolidated triage.

Thresholds (`minFiles`, `minSurface`, `maxAgents`, `minClusterFiles`) are tunable per repo — like the mining `clusterThreshold`, the right values are empirical, so they're config + overridable.
