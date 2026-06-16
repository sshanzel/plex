# @plex/neighborhood

Diff → changed symbols → **blast radius**. Given a `NormalizedDiff` (from `@plex/ingest`)
and a built code graph (from `@plex/code-graph`), it maps changed hunks to the symbols
they touch and scores every other file's coupling to the change with a
**personalized-PageRank** walk over `CoChange ∪ Imports ∪ Refs` edges. The result
(`ReviewNeighborhood`: `changed` locations + ranked, provenance-tagged `neighbors`) is
what `get_review_context` hands the reviewer as "what else could this change break."
Blast radius ≈ **coupling, not a call graph** (ADR-06): co-change catches runtime/DI
couplings that imports miss; no single edge source is trusted alone.

## Module map

- `src/compute.ts` — everything: the pure helpers (`rangesOverlap`,
  `symbolsTouchedByRanges`, `associationStrength`, `personalizedPageRank`) and the impure
  orchestrator `computeNeighborhood` (Kùzu queries via `@plex/code-graph`).
- `src/index.ts` — re-exports.

## The algorithm (`src/compute.ts`)

**1. Changed symbols.** For each diff file that has a graph node
(`fileExists` — a brand-new file has no node until reindex, a known blind spot noted to
the agent), intersect the hunks' `newRanges` with the file's symbol spans
(`symbolsTouchedByRanges`, inclusive 1-based overlap). Touched symbols become
`CodeLocation`s; if no symbol overlaps, the whole changed span (min start … max end) is
recorded file-level. **Deleted files stay seeds**: their node + edges are still in the
(pre-deletion) graph, so the walk surfaces their dependents — deleting a widely-imported
module is the strongest breakage signal, not an empty radius (a file-level `1..1` marker
is recorded as the changed location).

**2. Edge weighting.** The walk's `expand(frontier)` closure fetches the frontier's
undirected co-change/import/ref edges plus co-change degrees, and weights them:

- **co-change** → its **association strength** (Salton cosine, tuning.md §co-change):
  `associationStrength(co, degA, degB) = min(1, co / √(max(co,degA) · max(co,degB)))`
  where `deg` is the file's total incident CoChange weight (`getCoChangeDegrees`). This
  divides out *promiscuity* — a config/lockfile/barrel that co-changes with everything has
  a huge degree, so its pair strengths collapse toward 0; an exclusively-coupled pair
  scores 1. Read-time only — stored weights untouched, so ADR-26 incremental merging
  stays exact.
- **import** → fixed `importWeight` (default **0.4**); **precise-ref** → `refWeight`
  (default **0.5**) — empirical relative weights: structural edges are weaker evidence
  than learned co-change (tuning.md).

**3. Propagation — forward-push personalized PageRank** (`personalizedPageRank`, pure;
the db lives behind the injected `expand`). Residual mass starts as the teleport vector,
`1/|seeds|` on each changed file. Each hop (capped at `maxHops`, default **2**), every
frontier node `u` with residual `ru`:

- **deposits** `restart · ru` into its accumulated score (`restart` default **0.15**, the
  RWR/PPR convention — damping `d = 1 − restart = 0.85`);
- **forwards** the rest, `(1 − restart) · ru`, split across its out-edges in proportion to
  `w / Σw` — this degree normalization is the hub fix: a barrel/registry imported by
  hundreds natively *dilutes* what it forwards (no separate hub-damping knob; it subsumed
  the old `hubWeight` falloff from the ADR-06 refinement).

**Barrel transparency (ADR-06 refinement).** A **barrel / re-export file** (`getBarrelFiles`,
`@plex/code-graph` — 0 own symbols + import degree ≥ 3, i.e. `index.ts`-style `export … from`
plumbing) is passed to the walk as a **transparent** node: it deposits **no** mass (local
`restart = 0`) and forwards **100%** of its residual, then is dropped from the output. Rationale
(measured on the real graph): a barrel otherwise ranks **#1** — useless noise ("the barrel is
affected") that also sets the max-normalization ceiling and buries the genuine consumers behind it.
Making it transparent (a) removes the plumbing from the radius, (b) lowers the ceiling so real
consumers rank higher / clear `minScore`, and (c) passes mass through to consumers reachable *only*
via the barrel (the case where co-change is sparse — a fresh repo or a big mechanical PR). A barrel
that is *itself* a changed (seed) file is **never** transparent — the change is the signal. This is
the stronger "pure plumbing" sibling of the degree-normalization hub dilution above (which still
applies to non-barrel hubs and to promiscuous co-change).

A node reached by several paths accumulates more mass; `via` collects every edge
provenance that touched it; `distance` is the first hop that reached it. After the last
hop, in-flight residual deposits its `restart` share so reachable nodes aren't lost
(transparent nodes still deposit nothing, so they never surface).
Seeds are excluded from the output; scores are **max-normalized** to [0,1] (top neighbor
= 1), filtered by `minScore` (default **0.05**), sorted by score with **id as a stable
tie-break** (deterministic `maxNeighbors` cutoff, default **40**), and capped.

`maxHops`/`maxNeighbors`/`minScore` come from `config.neighborhood`; `restart`,
`importWeight`, `refWeight` are option defaults not exposed in user config. Bases and
history for every knob: `docs/design/tuning.md` §blast-radius.

## Invariants & gotchas

- **Purity split:** `personalizedPageRank`, `associationStrength`,
  `symbolsTouchedByRanges` are pure and unit-tested without I/O; all Kùzu access lives in
  `computeNeighborhood`'s `expand` closure (root convention: pure core, impure edges).
- Edges arrive **undirected** from `@plex/code-graph` queries (`-[:Imports]-` matches both
  importers and imported) — the "direction" in the walk is just frontier → neighbor.
- Zero/negative-weight edges are skipped in `expand` ingestion (`e.w <= 0`); a NaN
  co-change weight would poison the walk — the NaN guard lives upstream in
  `aggregateCoChange` (halfLife ≤ 0).
- `associationStrength` clamps with `max(co, deg)` and `min(1, …)` so a stale/mis-reported
  degree below the pair weight can never push a score above 1.
- Deleted files SEED the walk (their pre-deletion node/edges surface dependents); files
  absent from the graph contribute nothing — a stale graph silently shrinks the radius,
  which is why reviews auto-refresh on drift (ADR-25).
- The walk is bounded three ways: `maxHops` iterations, `minScore` floor, `maxNeighbors`
  cap — all three matter on big monorepos.

## Testing

- **Unit (vitest, pure):** `src/compute.test.ts` — multi-path reinforcement, hub dilution
  vs a low-degree path, max-normalization + seed exclusion, `minScore`/`maxNeighbors`,
  association-strength monotonicity and (0,1] bounds, range/symbol overlap edges. The PPR
  tests pass a plain adjacency as `expand` — no DB.
- **Integration (real Kùzu):** the `neighborhood`, `blast-hub`, and `cochange-hub`
  scenarios in `packages/engine/integration.mts` build a throwaway git repo + temp
  `g.kuzu`, then run `computeNeighborhood` end-to-end. One tsx process per scenario,
  **≤2 Kùzu opens** (ADR-17 — tsx crashes after ~5 opens). Never add a Kùzu-opening
  `.test.ts` to vitest.

See `docs/adr/README.md` (ADR-06, -17, -25) and `docs/design/tuning.md`.
