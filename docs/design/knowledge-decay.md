# Design note — knowledge decay (aging unreinforced pitfalls)

**Status:** proposed (not built). Captures the gap + a plan so we don't rediscover it. Promote to an ADR when we commit. Surfaced by the post-M12 lifecycle audit.

## Problem

The knowledge base **only grows and only strengthens**. Two related shortfalls:

- **No decay.** `consolidatePitfalls` (`packages/knowledge/src/promotion.ts`) returns a pitfall *unchanged* when it has no new incidents — so a pitfall that was analyzed once, never reinforced, and is no longer relevant keeps its confidence forever and keeps being retrieved (`retrieveRelevant`, top-K by cosine). Nothing ages out a stale or one-off lesson.
- **No pruning.** The store is an append-only JSONL log (`store.ts`); `replacePitfalls` rewrites it but never *drops* anything. Low-value pitfalls accumulate, dilute retrieval, and slow the full-scan retrieval (`store.pitfalls()` loads all of them per review).

This undercuts the stated premise (ADR-10: the loop should make review *sharper* over time). "Sharper" implies bounded, **recency-weighted** reinforcement and the eventual fading of lessons that stopped earning their place — not a monotonically growing pile.

**Already fixed (don't re-solve here):** consolidation was *non-idempotent* — it recomputed `confidence = clamp(p.confidence + 0.1·pos − 0.15·neg)` from the *current* (already-bumped) confidence over *all* incidents, so re-running saturated confidence. That's now an applied-incident ledger (`p.incidentIds`): each incident moves confidence exactly once. Decay is the orthogonal, **time-based** complement to that fix.

## Why now is fine to defer

The PR brain (rounds/findings) is per-PR and transient; this is only about the **global/per-project knowledge base**, which grows slowly (analysis + accepted incidents). It won't bloat in the short term, and decay is a *feature with tuning decisions*, not a correctness bug. Build it when the KB is large enough that retrieval quality or scan cost actually degrades.

## Candidate approaches (ranked by value ÷ cost)

1. **Recency-weighted reinforcement (cheap, highest value).** Add `lastReinforcedAt` to `Pitfall` (set whenever a fresh incident folds in). On consolidation, apply a half-life decay to confidence proportional to elapsed time since `lastReinforcedAt` *before* adding new evidence — mirroring the co-change recency model (ADR-06), which already does commit-size-weighted, recency-decayed aggregation and is a good template. A pitfall that keeps recurring stays strong; one that stops being seen fades. Pure function over `(pitfall, incidents, now)` → unit-testable; `now` is injected (the codebase already avoids `Date.now()` in pure paths for determinism).
2. **Retrieval-time recency tilt (no write path).** Leave stored confidence alone; multiply the retrieval score by a recency factor so stale pitfalls rank lower without being mutated. Lower blast radius (read-only), reversible, but doesn't shrink the store.
3. **Pruning threshold (storage hygiene).** During consolidation, drop pitfalls whose decayed confidence falls below a floor *and* that have no recent incidents — with provenance preserved (the linked `Incident`s stay; only the derived pitfall is removed, and re-analysis can regenerate it). Needs care: never prune a `repo`-scoped lesson that's simply dormant between touches of that repo, and never prune a **widespread real bug** (ADR-05 invariant — prevalence-by-severity must survive aging).

## Open questions / tuning

- **Half-life.** Co-change uses a recency decay tuned for commit history; pitfall relevance ages on a different (slower) clock. Needs its own constant, probably configurable (`ReviewerConfig`).
- **Decay clock = wall time or review count?** Wall-time penalizes a repo nobody touched for a month; "reviews since last reinforced" may track relevance better. Per-project pitfalls argue for a per-repo review counter.
- **Interaction with the idempotency ledger.** Decay reads `lastReinforcedAt`; the ledger reads `incidentIds`. Both live on the pitfall and are updated in the same consolidation pass — keep them consistent (a fold-in updates both).
- **Floor for analyzed-but-unconfirmed priors.** Public-repo/analyzed priors start low-confidence by design (ADR-11); decay must not instantly erase a useful-but-rarely-triggered lesson. A minimum floor or "never decay below seed×k" guard.

## Related but distinct: semantic incident de-duplication

A separate idea worth a line so it isn't conflated with decay: the idempotency ledger dedups incidents by **id**. It does *not* catch two *different-id* incidents that mean the same thing (e.g. the same outcome recorded via two code paths). A **semantic** guard — skip recording/reweighting when a new incident's embedding is ≥~0.99 cosine to an existing incident for the same pitfall — would close that, but at a real cost: it risks **under-counting genuine recurrence** (a pitfall recurring with near-identical wording across PRs is exactly the signal we want to reinforce). High threshold (≥0.99) and embeddings-optional (degrade to the id-ledger when no provider). Treat as an opt-in safety net, not a default — the deterministic id-ledger already closes the known double-count paths (C-G1 round-keyed findings, the analysis cursor, the applied-incident set).

## Where it plugs in

- `packages/core/src/types.ts` — add `lastReinforcedAt?` to `Pitfall`.
- `packages/knowledge/src/promotion.ts` — `consolidatePitfalls`: apply decay before folding new incidents; optionally prune.
- `packages/knowledge/src/retrieve.ts` — optional retrieval-time recency tilt (approach 2).
- `packages/core/src/config.ts` — half-life / floor constants.
