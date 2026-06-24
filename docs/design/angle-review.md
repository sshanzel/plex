# Design note — intense mode (concern-focused sub-agent review)

**Status:** implemented. Shipped as `intense` mode inside `plex-reviewer` — invoked with the
`--intense` flag (`/plex:review --intense`) or by asking in natural language for an intense
(or: thorough, critical, intensive) review.

**Supersedes:** `docs/design/parallel-review.md` (parallel-by-coupling-cluster, retired — the
cluster-fan-out never fired in practice because real changes are tightly coupled; a single
reviewer was faster).

## Problem

The retired parallel-by-cluster approach split a diff by *subsystem affinity* and gave each
sub-reviewer a cluster. This didn't deliver: real changes are almost always one tightly-coupled
blob, so the guardrail kept choosing `single`. The gain was theoretical; the cost was real
(orchestration overhead, context fragmentation across agents).

The actual bottleneck is not *how many files* a reviewer sees — it's *how many concerns* a
single pass has to hold at once: security, correctness, test coverage, and line-by-line scrutiny
have different attention patterns. An agent optimizing for all of them at once does each one
shallowly.

## Approach: sub-agents per concern

Spawn one sub-agent per concern — each running a single focused pass over the **same full Plex
context** — rather than one sub-agent per file cluster.

| Concern | Focus |
|---|---|
| Security | Trust boundaries, injection, auth/authz, secrets, deserialization, CORS/CSP |
| Correctness | Logic bugs, null/undefined, async errors, error handling, type safety, edge cases |
| Test Coverage | Untested paths, missing edge-case tests, dead tests, async coverage gaps |
| Line-by-Line | Careful hunk-by-hunk reading + blast-radius contract breakage at a micro level |

## Key invariants

**`get_review_context` is called once by the orchestrator (the main `plex-reviewer` agent).**
Sub-agents receive the full context embedded in their prompt. Sub-agents do NOT call any Plex
MCP tools — doing so would bump the PR brain round, corrupt round tracking, and cause duplicate
blast-radius/staleness work.

**All sub-agents receive the full Plex context.** Blast radius, changed symbols, knowledge
pitfalls, `unexplainedChanges`, `openComments`, `priorRounds`, and `deterministic` findings are
not exclusive to any one concern. Each sub-agent applies them through its own lens — a security
sub-agent uses blast radius to trace trust-boundary violations; a correctness sub-agent uses it
to check whether coupled-file consumers broke.

**`submit_findings` is called once by the orchestrator.** The orchestrator deduplicates across
the four findings arrays (same file + overlapping line range ±5 + similar title → keep
highest-confidence version) before calling submit. This prevents the same finding appearing four
times and inflating the ranking budget.

**Surface threshold.** If `reviewPlan.surface < 30`, the test-coverage sub-agent is folded into
the correctness sub-agent (3 agents instead of 4). Tiny diffs rarely have meaningful coverage
gaps that need a dedicated pass.

## How `reviewPlan` metadata is used

`reviewPlan` (pure, `@plex/findings`) is no longer used as a parallelization gate. Its `surface`
field serves as the threshold for folding the test-coverage agent (< 30). The `units[].files`
coupling clusters are available in the context but not used as sub-agent scope boundaries —
concern separation (not file-cluster separation) is the partitioning axis.

## Codex

Codex does not support sub-agents. The `plex-review` Codex skill (generated from
`plex-reviewer.md` by `scripts/gen-codex-skills.mjs`) replaces the parallel fan-out with a
sequential structured sweep: Security → Correctness → Test Coverage → Line-by-Line, each as a
labeled section the model steps through in order. The result is a deterministic, auditable sweep
rather than open-ended "review this diff."

## What does NOT change

- The standard single-pass `plex-reviewer` path is unchanged — it remains the default.
- Blast radius, deterministic findings, and knowledge retrieval are still pre-assembled by
  `get_review_context` — sub-agents receive grounding as facts, never re-call the context tool.
- `submit_findings` is still a single consolidated call.
- `reviewPlan` / `partitionByCoupling` stays in `@plex/findings` — same code, `surface` field
  repurposed as an agent-count threshold.
