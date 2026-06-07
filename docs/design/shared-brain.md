# Design note — a shared (team) brain

**Status:** exploration (not built). Captures the options + the architectural tension so we don't paint ourselves in. Promote to an ADR when a direction is chosen.

## What's local today (and why sharing isn't free)

Everything per-repo is **per-machine**:

- **Code graph** (`graph.kuzu`) — derived from the checkout; rebuildable in seconds (incremental).
- **PR brain** (`brain.kuzu`) — rounds / findings / verdicts / comments. Lives at `<reviewerDir>/brain.kuzu`, and `reviewerDir` is keyed by **`repoId` = hash of the absolute path** (`paths.ts`). So two teammates reviewing the *same* PR have **two separate brain files** under two machine-specific ids.
- **Knowledge base** (`~/.plex/knowledge/`, JSONL) — pitfalls + incidents. Per-machine, settable via `PLEX_KNOWLEDGE_DIR`. `KnowledgeStore` is a concrete class over a dir (not yet an interface).

Two hard facts make "share it" non-trivial:

1. **Identity is machine-specific.** `repoId` hashes the *local absolute path*, so the same GitHub repo has a different id on every machine and worktree. **Any shared state must be keyed by a stable, machine-independent identity** — the git remote slug (`owner/repo` from `git remote get-url origin`), falling back to path-based for local-only repos.
2. **Embedded = single-writer (ADR-30 on purpose).** We removed FalkorDB to go fully embedded — Kùzu is a single-file, single-process store. It does **not** support concurrent writers across machines (a shared mount → corruption). Sharing reintroduces a coordination point, which is exactly what the embedded design avoided. That tension is the whole decision.

## What's actually worth sharing (by value ÷ cost)

- **Knowledge base — share first.** This is the "team gets sharper" payoff: accumulated pitfalls + confidence. It's small, append-mostly JSONL, the store is nearly an interface already, and ADR-21 scope (`global` vs `repo`) already supports per-project team knowledge — it just needs a shared store + a stable repo key. **Highest value, lowest risk.**
- **PR brain — share second, harder.** Sharing gives cross-reviewer consistency on the same PR and a team-wide "changed-without-feedback" signal. But it's a binary Kùzu file, per-PR-keyed, and concurrent (two reviewers, same PR). A safe shared brain wants a **service**, not a synced file.
- **Code graph — don't bother (or only as a cache).** It's derived and rebuildable per machine; sharing is a pure perf optimization (snapshot/restore), never a correctness need.

## Options

**A. Git-backed shared knowledge (recommended first step, no service).**
Keep the brain local; share the *knowledge*. Store pitfalls/incidents as JSONL in a shared location (a `plex-knowledge` repo, or a tracked path), keyed by remote slug. Each machine reads it; appends sync via normal git. Run **`consolidate_knowledge` in CI (single writer)**, not per-machine, because consolidation does a full `replacePitfalls` rewrite (a lost-update hazard under concurrency). Append-only logs + the per-line corrupt-tolerance (already shipped) merge gracefully. Eventual consistency, but real value and zero infra.

**B. One self-hosted brain service (the real "shared brain").**
Run a single Plex brain backend the team's MCP clients connect to (Kùzu/Postgres behind a service, or the hosted bot's backend). Brain + knowledge live server-side; the service serializes writes → real-time, concurrent-safe, consistent. This is the genuine shared brain — and it's essentially the **hosted-bot backend, self-hosted**. Cost: reintroduces a service (against the embedded goal) — auth, network, ops.

**C. Object-storage snapshot + lock.**
Snapshot `brain.kuzu` to a shared bucket, pull-before / push-after, guarded by a per-target lock. Works with embedded Kùzu, but concurrency degrades to last-write / lock-wait — awkward when two people review at once. A stopgap, not a destination.

## Prerequisites (shared by all options)

- **Stable identity:** resolve a repo's `git remote get-url origin` → `owner/repo`; key shared brain/knowledge by that, fall back to path-based for no-remote repos. Keep the **code graph** path-keyed (per checkout/worktree, ADR-32) — only *shared* state moves to remote-slug keying.
- **Pluggable `KnowledgeStore`:** extract the interface (today it's a concrete dir-backed class) so a git/S3/HTTP/Postgres backend drops in behind it.
- **Single-writer consolidation:** `consolidate_knowledge` (full rewrite) must run from one place (CI / the service), not concurrently per-machine.

## Recommended path

1. Extract a `KnowledgeStore` interface + add a **remote-slug repo identity** (cheap, unlocks everything).
2. Ship **git-backed shared knowledge** (Option A) — the team learns together with no service.
3. If/when real-time shared PR-brain state is wanted, that's the **hosted/self-hosted service** (Option B) — same backend as the hosted bot. Don't try to make a synced Kùzu file pretend to be a concurrent database.
