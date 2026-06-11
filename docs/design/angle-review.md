# Design note — angle-based sub-agent review

**Status:** planned. The coupling-cluster primitives it relies on (`partitionByCoupling`,
`reviewPlan`) are already built; the orchestration (spawning sub-agents per angle) is the next
step. Promote to an ADR when the first angle agent lands.

**Supersedes:** `docs/design/parallel-review.md` (parallel-by-coupling-cluster, retired — the
cluster-fan-out never fired in practice because real changes are tightly coupled; a single
reviewer was faster).

## Problem

The retired parallel-by-cluster approach split a diff by *subsystem affinity* and gave each
sub-reviewer a cluster. This didn't deliver: real changes are almost always one tightly-coupled
blob, so the guardrail kept choosing `single`. The gain was theoretical; the cost was real
(orchestration overhead, context fragmentation across agents).

The actual bottleneck is not *how many files* a reviewer sees — it's *how many concerns* a
single pass has to hold at once: security, correctness, performance, and style have different
attention patterns. An agent optimizing for all of them at once does each one shallowly.

## Approach: sub-agents per review angle

Spawn one sub-agent per review *angle* — each running a single focused pass — rather than one
sub-agent per file cluster.

Candidate angles (to be refined as we observe what a single-pass reviewer misses):

| Angle | Focus |
|---|---|
| Correctness | Logic bugs, edge cases, error handling, race conditions |
| Security | Trust boundaries, input validation, auth, secrets |
| Performance | Hot paths, N+1, allocations, unnecessary re-computation |
| Contracts | API surface, breaking changes, type invariants, schema drift |

Not every angle fires on every change — a config-only diff doesn't need a performance angle.
The orchestrator decides which angles are relevant from the diff type + surface.

## How `reviewPlan` metadata is reused

`reviewPlan` (pure, `@plex/findings`) is no longer used as a parallelization gate. Its output
is repurposed as **scoping metadata** for angle agents:

**`units[].files`** — the coupling clusters (union-find over co-change + import edges). Each
angle agent receives its assigned cluster as a "primary focus" list alongside the blast radius —
rather than 20 files with no grouping, it sees which files move together and can reason about
them as a subsystem. A high-`surface` change with multiple clusters may spawn an angle agent
per cluster × angle, but the default is one instance of each angle over the whole diff.

**Cross-cluster edges** — file pairs that appear in coupling edges *between* clusters are
integration seams: a change in one cluster that can affect another. These surface as a dedicated
"integration" angle (or are fed as annotated context to the correctness angle). This is the
finding a per-cluster split would sever — here it becomes a first-class concern instead.

**`surface`** (changed symbols + blast-radius nodes) — proxy for review complexity. Low surface
(< ~150) → skip the fan-out, a single pass is faster. High surface → spawn the angle fleet.
The threshold mirrors the retired parallel-review guardrail.

## Codex

Codex does not support sub-agents. The `plex-review` Codex skill runs a single sequential pass.
To compensate, its instructions are explicit and structured: it steps through each angle in
order, naming what to look for at each step, so the model doesn't have to decide scope on the
fly. The result is a deterministic, auditable sweep rather than open-ended "review this diff."
The angle list and their focal questions are embedded directly in the skill body.

## What does NOT change

- `reviewPlan` / `partitionByCoupling` stays in `@plex/findings` — same code, repurposed role.
- The single-reviewer path (`plex-reviewer` agent) is unchanged and remains the default for
  small or moderately-sized changes.
- The blast radius, deterministic findings, and knowledge retrieval are still pre-assembled by
  `get_review_context` — angle agents receive grounding as facts, never re-call the context tool.
- `submit_findings` is still a single consolidated call — the orchestrator merges and deduplicates
  across angles before submitting.
