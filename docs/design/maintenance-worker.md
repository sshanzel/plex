# Design — the background maintenance worker (ADR-43)

**Status: built (ADR-43).**

## Problem

Every deferred Plex job runs only on a manual command, and nobody runs commands on `main`:

- **Loop closure** — after a PR merges, no one reviews `main`, so landed findings never reconcile and
  their incidents never reach the global knowledge base (`~/.plex/knowledge`). The pr-responder *tried*
  to do this (`reconcile_outcomes`) but it silently dropped whenever the plex MCP tools weren't loaded
  in-session.
- **Knowledge consolidation** — ADR-42's positive-path **decay + pruning** only take effect when
  `consolidatePitfalls` runs, i.e. `plex consolidate`. Nobody runs it → the decay ships **dormant**.
- **Base-graph freshness** — `main`'s code graph drifts; branch/worktree copies seed from a stale base.
- **Review-history analysis** — distilling merged PRs into pitfalls is a manual `plex analyze`.

The hard constraint: the PR brain is **per-machine, path-keyed** (`<repo-data>/brain.kuzu`). A CI runner
is a *different machine with an empty brain*, so CI closure is structurally impossible, and a shared
brain is an explicit non-goal (`shared-brain.md`). But the durable learning store `~/.plex/knowledge` is
**global and per-machine, not brain-bound** — it survives a merge regardless of which brain saw the
fix. Only the *tail* (the final round's fixes, never reconciled) is lost.

## Solution — a detached worker that maintains `main`

A single background worker, spawned best-effort by ordinary Plex activity on the developer's machine,
that **maintains `main` as the canonical, always-fresh base**. It owns every deferred job, superseding
both the flaky pr-responder bookkeeping and the git hooks ADR-36 removed (the trigger is Plex activity,
not git events).

### Why target `main`

Resolved from any worktree (`resolveMainRepoPath` → the default-branch / primary checkout). `main`'s
data dir is **centralized + durable** (`~/.plex/repos/<id>`), not in-workspace like a linked worktree
(ADR-40) — so targeting `main` sidesteps the worktree-brain-death problem for the canonical base. A
branch's own ephemeral graph/brain is never touched by the worker.

## The job framework

`runMaintenance`/`sweepRepo(repoPath, config, now)` resolves `main`, acquires a single-flight lock, runs
each job wrapped in try/catch (one failing never blocks the next), persists per-job cursors, releases
the lock. Each job is best-effort and idempotent:

1. **Reconcile (loop closure).** `brain.openTargets()` (open, non-`awareness` findings + a recorded
   round) → `diffSourceFromTarget(target, baseRef)` → if the current head advanced past the per-target
   cursor → `reconcileOutcomes` (auto-accept → `submitVerdict` → `learnIncident` → global KB). The
   reliable replacement for the pr-responder's `reconcile_outcomes`.
2. **GraphFreshness.** If `main`'s indexed sha ≠ HEAD → re-index in an **isolated child**
   (`indexIsolated`) — *never in-process*: opening the code graph for a write while the brain is open
   SIGSEGVs Kùzu (ADR-17), the exact reason the review uses an isolated child.
3. **Consolidate.** Run `consolidateKnowledge` → ADR-42 decay + pruning on the global KB. **Without this
   job ADR-42 is dormant.** Cadence-gated (≈6h).
4. **Analyze.** `analyzeRepo` incrementally — gated on a real embedding provider + an LLM (else
   skipped). The heaviest job (tokens); cadence-gated (daily), runs last.

## Triggers — two modes

- **Lazy / proactive:** `maybeSpawnSweep` (`spawn`+`detached`+`unref` — must NOT block) at the end of
  `assembleReviewContext` + the MCP `reconcile_outcomes` handler. No-op in dev/tsx (no built CLI beside
  `argv[1]`). **Debounced** (≤1 spawn / 10 min / data dir) so triggering from every review is safe.
- **Eager / "tight":** review-start base-staleness. Record `base.sha` at worktree seed; on each review
  compare it to `main`'s HEAD. `fresh` → nothing. `reseed` (main advanced, main graph fresh) → cheap
  re-copy inline (`indexRepo` seed path). `refresh-main` (main advanced but its graph is stale) → spawn
  the worker **tight** (bypass debounce) to refresh main; this review proceeds on the current base (the
  accepted first-review-may-be-stale trade-off), the next re-seeds cheap.

## Idempotency (the safety invariant)

A sweep must never duplicate work (esp. global incidents). Each job is idempotent by construction:
reconcile rides `submitVerdict`'s learning-idempotency (skips a re-accept of the same finding; projects
`outcome` onto the brain finding so it leaves `priorFindings`) **plus** the per-target head cursor;
consolidate is a pure overwrite (`replacePitfalls`, never appends); index is a no-op when fresh; analyze
rides the `analyze-state.json` scan cursor. Plus the worker-level guards: single-flight lock, debounce,
per-job cadence. The pure decision helpers (`headAdvanced`/`isDebounced`/`jobDue`) are unit-tested.

## Sidecars (`packages/engine/src/paths.ts`)

`sweep-state.json` (per-target reconcile cursor + per-job last-run), `sweep-last.txt` (debounce mtime),
`sweep.lock` (single-flight; a lock older than 30 min is stolen — a crashed sweep), `base.sha` (the
`main` HEAD a worktree seeded from).

## Concurrency & safety

Single-writer Kùzu: the worker opens the brain briefly per job; a review colliding with it surfaces the
existing `RepoBusyError`, and the reconcile job catches `isLockError`/`RepoBusyError`, marks `busy`,
leaves the cursor unadvanced (retry next sweep), and never throws. The worker is **node-only** (ADR-17):
tsx no-ops the detached spawn and the isolated index; the node E2E (`scripts/sweep-check.mjs`) exercises
the real path that tsx structurally can't.

## What it does NOT do (accepted limitations)

- A linked worktree's *own* brain still dies with its folder (ADR-40) — the worker targets durable
  `main`, it does not cross worktrees.
- Head-advance is detected offline (git head vs cursor). A PR target whose head resolves empty is
  condemned to the terminal `CLOSED_TARGET` sentinel (stop re-probing) **only after `gh pr view`
  confirms it's `CLOSED`/`MERGED`** — a transient gh failure (network/auth, or gh missing in the
  detached env) just retries, so one outage never permanently disables a live PR's closure. **A
  reopened PR is not auto-recovered by the sweep** (the sentinel is terminal) — but its closure rides
  its re-review's inline reconcile (ADR-36), so this is an accepted narrow gap, not a lost loop.
- It's per-machine. The MCP tools (`reconcile_outcomes`/`consolidate_knowledge`/`analyze_*`) are kept as
  proactive escape hatches but are no longer load-bearing.

## Future — team scale (not built)

For a team, the per-machine constraint dissolves with a **cloud GitHub-bot review managing a shared
brain** (the bot is the machine; the brain is cloud-hosted + shared). That makes CI-side closure
possible — the exact wall this local worker routes around. The local worker is the local-first answer;
the bot is its team-scale complement. See `shared-brain.md` for the identity/concurrency tensions a
shared brain must resolve.
