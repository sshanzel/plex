# Design note — richer outcome signals for analyzed incidents

**Status:** proposed (not built). Captures the plan + the rate-limit/attribution risks so we don't rediscover them. Promote to an ADR when we commit to it.

## Problem

`IncidentOutcome` has four grades — `fixed | accepted | rejected | reverted` — but the analysis path only ever emits two:

```ts
// packages/distill/src/outcome.ts
outcomeFor({ prMerged }) => prMerged ? 'accepted' : 'rejected'
```

`fetchCommentsForPr` (REST `pulls/{n}/comments`) captures `prMerged` and nothing else — **no thread `isResolved`, no resolving diff.** So:

- Every substantive comment that survives the LLM distiller on a **merged** PR is stamped `accepted`, even if the author silently ignored it and merged anyway. We can't tell *applied* from *ignored-but-merged*.
- `fixed` and `reverted` are never produced; the `reverted: 1.5` bonus in `outcomeWeight` is dead code.
- `consolidatePitfalls` counts `accepted`+`fixed` as positive and `rejected` as negative — so even if we *did* emit `fixed`, it would change nothing until the weighting also distinguishes it.

Note the LLM distiller already reads thread **replies** and SKIPs suggestions the discussion shows were dismissed/intentional (ADR-20). So this is about the *weight* of what survives the gate, not the gate itself. The silent-ignore-but-merge case is the gap.

## Candidate signals (ranked by value ÷ cost)

1. **Resolving-diff match (strongest).** Did the comment's suggested change actually land in a commit *after* the comment? If yes → `fixed` (verified positive); if the PR merged but no matching change → keep `accepted` (weaker, "merged but unverified"). Matching prose comments to a diff is a judgment, not a string compare — either a conservative heuristic (the touched lines around `path:line` changed after `createdAt`) or an LLM "was this addressed? yes/no" call.
2. **Revert detection → `reverted` (1.5).** The flagged code/region was reverted in later history → the reviewer was right. Cheap-ish locally (`git log` for a revert touching the region); needs history server-side.
3. **Thread `isResolved` (weak on its own).** A secondary input only. Humans resolve threads for many reasons (fixed, won't-fix, "discussed offline", tidying) and many teams never resolve at all — and it only exists for **review** threads (inline), not issue-level PR comments. Use it to *corroborate* a resolving-diff match, never as the sole signal. Available only via GraphQL `reviewThreads(first:N){nodes{isResolved …}}`.

## Data sources differ by deployment

- **Local (personal use):** `git` is right there. The resolving-diff match and revert detection are **cheap and offline** — `git log -L`/`git log -- <path>` over commits after the comment SHA. `isResolved` is **not** available without a `gh`/API call. → start here: local-git resolving-diff match, no API needed.
- **Hosted bot:** you have the GitHub API (so `isResolved` is reachable) but pay **rate limits**. This is where the cost shows up (see below). Webhook-on-merge means you can compute the signal once, at merge, with the full thread + commits in hand.

## Rate-limit / cost discipline (the part not to forget)

A naive "per comment, fetch the commits after it and diff" over historical analysis (hundreds of PRs × many comments) will exhaust the GitHub App budget (5000 req/hr; 15000 GHEC).

- **One GraphQL query per PR, not per comment.** Pull `reviewThreads{ isResolved, comments{ path, line, body, createdAt } }` + the PR's `commits` in a single paginated query. Avoid the REST `pulls/{n}/comments` + N follow-ups.
- **Reuse the incremental cursor** (`.plex/analyze-state.json`) — already skips scanned PRs; never re-scan.
- **Respect `X-RateLimit-Remaining` / `Retry-After`**; exponential backoff; stop the batch (don't hammer) when the budget is low and resume next run.
- **Cache per-PR** thread+commit data; compute the outcome once at PR-merge (webhook), not on every review.
- **Cap historical depth** on first backfill; prefer recent PRs (recency-weighted, like co-change).
- **Prefer local git** when running locally — zero API calls for the resolving-diff/revert match.

## Required paired change (else it's a no-op)

Deriving richer outcomes only matters if the math uses them. Two facts about the math today:

- **`outcomeWeight` (the 1.5/1.0/0 function) is never called** — it's exported and tested but wired into nothing. The 1.5 `reverted` bonus is purely aspirational.
- The real feedback math is in `consolidatePitfalls`, and it uses **plain counts** with hardcoded coefficients: `confidence += 0.1 * #(accepted|fixed) − 0.15 * #(rejected)`, clamped to [0,1]. `reverted` is neither positive nor negative there.

So the paired change is: make `consolidatePitfalls` actually *use* a per-incident weight (i.e. call `outcomeWeight`, or richer coefficients) so `fixed` strengthens more than a bare `accepted` and `reverted` (1.5) counts as the strongest positive — instead of all positives being worth a flat `+0.1`.

## Risks / downsides (why this isn't free)

- **Attribution is heuristic and can be *confidently wrong*.** A false `fixed`/`accepted` reinforces a pitfall that was ignored; a false `reverted` over-weights (1.5×) something. Because it feeds confidence, bad attribution **compounds**. The current binary signal is dumb but predictable. → Be conservative: only emit `fixed`/`reverted` on a high-confidence match; **fall back to the binary `accepted`/`rejected` otherwise.**
- **`isResolved` is a weak proxy** — never the sole basis for a weight.
- **More surface to maintain** (GraphQL, pagination, rate-limit handling, an LLM "was-this-addressed" path if used) vs the current 3-line function.
- **Local↔hosted asymmetry** — the best signal source differs, so expect a branch (local git vs API).

## Suggested MVP (smallest useful slice)

Local-git **resolving-diff match** only: for each surviving comment, if a commit after `createdAt` modified the region around `path:line`, emit `fixed`, else `accepted` (unchanged). Conservative; no API; pair with the `outcomeWeight`/`consolidatePitfalls` update; unit-test the matcher on a throwaway git repo. Defer `isResolved` + revert detection to the hosted path, behind the rate-limit discipline above.
