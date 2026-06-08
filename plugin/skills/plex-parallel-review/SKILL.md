---
name: plex-parallel-review
description: Run a Plex code review, fanning out into parallel sub-reviewers when (and ONLY when) the change is big enough and splits into independent coupled clusters. Use for reviewing a large diff, branch, or PR where a single-pass review would be slow. Consolidates every sub-reviewer's findings into ONE ranked stream.
---

# PR Parallel Review (orchestrator)

You are the **orchestrator**, running in the main session — the only place that can spawn
subagents (a subagent cannot spawn another). Your job: get the review plan from Plex, fan out
*only when it pays off*, and **consolidate** every sub-reviewer's findings into one ranked,
deduped stream — exactly as if a single reviewer had seen the whole change.

The decision to fan out is **not yours to guess** — Plex makes it from the coupling graph
(`reviewPlan`). You obey it. Fanning out a small or tightly-coupled change is *worse*: N× the
tokens for a slower, dumber review that severs cross-file reasoning. The guardrail exists so
parallelism only happens when it actually wins (a big change that splits into independent
clusters). When in doubt, Plex says `single`, and you do one pass.

## Procedure

1. **Load the Plex tools.** If `mcp__plex__get_review_context` isn't directly callable, load the
   deferred tools with `ToolSearch("mcp__plex__")`. Never fall back to a hand review.

2. **Pick the diff** (same surface as `plex-reviewer`): default staged; honor a named branch/PR.
   Thread the **same** `source` / `mode` / `baseRef` / `pr` through every Plex call below so they
   land on the same PR brain.

3. **Get grounding once** — call `mcp__plex__get_review_context`. Calling it **once** matters:
   it advances the PR-brain round and computes the blast radius over the *whole* diff. Read
   `reviewPlan` from the result:
   - `reviewPlan.strategy` — `single` or `parallel`.
   - `reviewPlan.units[]` — for `parallel`, each unit is a weakly-coupled cluster of changed
     `files` to review together. For `single`, one unit with all files.
   - `reviewPlan.reason` — the auditable why (surface it to the user).

4. **Branch on the strategy:**

   ### `single` (the common case)
   Do not spawn anything. Review the whole change yourself following the `plex-reviewer`
   procedure (read changed code **and** the `blastRadius` files; reason from first principles;
   check code against `changeContext`; scrutinize `unexplainedChanges` first), then go to step 6
   with your findings.

   ### `parallel`
   Fan out **one `plex-reviewer` subagent per unit, in parallel** (spawn them in a single batch
   so they run concurrently). Give each subagent a **focused-unit** prompt:
   - `FOCUS FILES:` the unit's `files` — review only the changes in these.
   - The grounding it needs, sliced from the single `get_review_context` you already have:
     - `deterministic` findings whose `file` ∈ the unit's files;
     - the **full** `blastRadius`, `knowledge`, `changeContext`, `plex.md`, and any
       `unexplainedChanges` in the unit's files (a unit must still see what it's coupled to).
   - The instruction: **return raw findings as a JSON array** (the `submit_findings` finding
     shape) and **do NOT call `get_review_context`, `submit_findings`, or `record_outcome`** —
     you, the orchestrator, consolidate and submit once. (Re-calling `get_review_context` would
     bump the round N times and recompute the blast radius per unit — wasteful and wrong.)

   See `plex-reviewer`'s **"Focused unit mode"** section — it's built for exactly this.

5. **Consolidate (the whole point).** Collect every unit's findings into one list, then do a
   cross-unit pass yourself — this is the value parallelism would otherwise destroy:
   - **Dedup / reconcile:** the same issue spotted by two units (e.g. a shared helper), or two
     units reaching contradictory conclusions about the same coupling — merge or resolve it.
   - **Cross-cluster interactions:** bugs no single unit could see because the cause is in one
     cluster and the effect in another — e.g. unit A changes a function's signature/contract and
     unit B calls it, or A and B both write the same state. Use the full `blastRadius` to hunt
     these and add them as findings (note the blast radius).

6. **Submit once, then stop.** Make **one** `mcp__plex__submit_findings` call with the full
   consolidated list (and the same diff source). Plex merges with deterministic findings, applies
   scoped/semantic waivers, ranks, triages, and — when reviewing a PR with auto-comment on — posts
   the single review to the PR. Present the returned ranked stream highest-signal first, in the
   `plex-reviewer` shape (defects, then a separate **"Worth confirming"** section for `awareness`) —
   and follow `plex-reviewer`'s **lean-presentation** rule: issue + why + `file:line`, **no raw
   confidence numbers**, and **no meta "State"/run-summary recap**. **Do not ask the user to accept
   / reject / waive** — the review is autonomous. Suggest **`/pr-master:respond`** to
   triage what landed and close the loop.

## Rules
- **Never fan out against `reviewPlan`.** If it says `single`, one pass — don't second-guess it
  because the diff "feels" big. The guardrail already weighed file count, surface, and coupling.
- **Exactly one `submit_findings`** per review, over the consolidated set — never one per unit
  (that would post N partial PR reviews and rank each cluster in isolation).
- **Exactly one `get_review_context`** — units get their grounding sliced from it, not by
  re-calling it.
- Every file in the change is covered by exactly one unit (Plex guarantees this); if a finding
  spans units, it belongs to the consolidation pass, not to a unit.
- Anchor every finding to `file:line`. If the change is clean, say so plainly — after checking the
  blast radius and the cross-cluster interactions.
