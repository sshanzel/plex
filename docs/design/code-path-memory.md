# Code-path memory

> Plex remembers the concerns raised at a piece of code, and warns you when you touch it again —
> especially when you're about to re-break something you already fixed. That memory is grounded in
> your actual code graph and how your code co-evolves, not in how your diff happens to read.

This is the feature that separates Plex from a linter. A linter is **stateless**: it pattern-matches
the text in front of it and has no idea this exact function was the subject of a long review thread
six PRs ago, or that the last time someone touched it they introduced the bug you're about to
reintroduce. Plex keeps that history, anchored to the code, and surfaces it at exactly the moment
it's relevant. (Decision: [ADR-47](../adr/README.md). Composes with ADR-06 co-change, ADR-18 flat
store, ADR-42/44 the retrieval tilts, ADR-46 the durable lineage it reads.)

## The idea in one model: the incident is an edge

Plex records two kinds of thing:

- a **Pitfall** — a generalized, reusable lesson ("validate the tenant id on every query");
- an **Incident** — one concrete occurrence of that lesson: *this* comment / *this* accepted finding,
  with its outcome and timestamp.

An incident is not a footnote on a pitfall — it is the **edge** that connects the lesson to a place
in the code:

```
Pitfall  ──{ outcome, ts, location }──▶  Symbol
```

So the location belongs **on the incident** (the edge), and everything else is a view over the same
records:

| View | Question it answers |
| --- | --- |
| **symbol → incidents** | "What has ever been flagged *here*?" |
| **pitfall → incidents** | "Everywhere this lesson has fired." |
| **incident** | "This concern, at this symbol, with this outcome, at this time." |

One write, three queries — no duplication.

## What "location" means: `file#name`, not a line

Each incident is anchored with a **stable symbol key**: `symbolKey(file, name)` = `file#name`. The
choice is deliberate:

- **Not the code graph's `Symbol.id`** (`file#name#startLine`) — that embeds the line, so it breaks
  the moment the symbol moves down a few lines. We *want* to survive that drift.
- **Not the bare name** — `handle` exists in fifty files; the key has to be joinable back to a file.
- A symbol that **moves** keeps its key (good — same concern, same code). A symbol that is **renamed**
  genuinely becomes a different key (also good — it's different code now).

Granularity is **symbol-level** by design: line-level is too brittle (drifts on every edit);
file-level is too coarse (every concern in a busy file would fire at once). Symbol is the sweet spot.

## Capturing the anchor (where the data comes from)

- **Live accepts** (you accept a Plex finding) anchor *precisely*. The finding already knows its
  symbol; that symbol rides the brain `Finding` record, and the accept inherits it. One capture point
  (`submitVerdict` resolving from the brain finding by `findingId`) covers **both** the explicit
  `record_outcome` accept and the automatic reconcile "you fixed it" accept. This is the highest-value
  path — it's the recurrence loop: *Plex flagged it here → you fixed it → you're back at this symbol.*
- **Mined comments** (from `/plex:analyze` over PR history) capture the comment's **line** only. There's
  no code graph open at analyze time, and a historical line may not map cleanly to today's symbols, so
  we don't pretend to resolve a symbol — the review-time match falls back to line-overlap.

## Matching at review time (the overlay)

When you review a change, Plex already computes the symbols your diff touches (`nb.changed`) and their
co-change neighbours (`nb.neighbors`, the blast radius). The **pure** `matchCodePath` intersects the
retrieved pitfalls' incident history against those, via a **precision ladder** (strongest first):

1. **symbol-key** — an incident anchored to the exact `file#name` you're editing. Durable, survives drift.
2. **line-overlap** — the incident's line falls inside the changed symbol's span (the drift / mined fallback).
3. **file** — only for a file-level change with no named symbol (weak; never competes with a symbol hit).
4. **coupled-file** — an incident in a file that *co-changes* with your change set, scaled by the
   co-change strength. This is the propagation step (below).

A direct hit whose strongest prior outcome is `fixed` / `accepted` / `reverted` is a **regression
sentinel** — the headline signal.

The result is two things: an explainable list of `codePathAlerts` (sentinels first) that the reviewer
agent foregrounds, **and** a bounded boost folded into the pitfall ranking so the location-relevant
lessons rise to the top. Semantic similarity stays the base; location is the high-alert overlay.

### The regression sentinel

> *"You're changing `tenantQuery()` — a bug here was flagged and fixed in this code path before. Verify
> you're not reintroducing it."*

A stateless tool cannot say this. It requires memory of a **specific prior outcome at a specific
symbol**, surfaced the moment that symbol re-enters a diff. It is the single most valuable thing
code-path memory produces.

### Co-change propagation: concerns radiate along how code actually changes together

A concern anchored at symbol `S` is not only relevant when you touch `S` — it's relevant when you
touch the code that historically ships *with* `S`. Plex already learns this from git history as the
**co-change graph** (ADR-06): files that change together are coupled, weighted by how exclusively and
how recently. Code-path memory reuses that graph — the same blast-radius walk that finds "what else
could this change break" now also finds "what concerns live in this change's coupling neighbourhood."
That join of the two graphs — *recorded concerns × real co-evolution* — is something a linter has no
machinery to express.

(v1 propagates at **file** level via the existing PPR neighbours; a symbol-level co-change graph is the
documented upgrade.)

## Why it stays cheap and honest

- **No new database, no extra graph open.** Knowledge stays in the flat JSON store (ADR-18). The match
  is pure JavaScript over that store plus the neighbourhood Plex already computed — by the time it runs
  the code graph is closed, so it never takes a lock or risks the single-writer SIGSEGV (ADR-17).
- **It works with no API key.** The overlay reads symbols and JSON incidents — no embeddings required.
  The differentiator is precisely the part that survives a key-less install; semantic retrieval is the
  part that degrades to keyword matching without a provider, but code-path memory keeps working.
- **Bounded and explainable.** One alert per (pitfall, kind, symbol); at most a handful of incident ids
  cited; file-only and coupled signals are weak and never flood the precise symbol matches. Every alert
  carries its provenance (the prior outcome + the incidents behind it), so it reads as a fact, not a
  vibe (ADR-02). Boosts are capped (a boosted score can't exceed 0.99).
- **Scope-safe.** Repo scoping (ADR-21) is inherited from the retrieval set, so one repo's history
  never leaks into another's review. Suppression (negative) pitfalls are skipped — they have their own
  negative-knowledge path.

## See it: the explorer

In `plex serve`, clicking a code **Symbol** shows the concerns recorded at it — the incidents, their
outcomes, and the pitfalls they feed. The edge is **solid** when the incident is keyed to that exact
symbol (`file#name`) and **dashed** when it matched only by line-overlap (e.g. a mined comment with a
line but no resolved symbol). It's the same store-join pattern the lineage view already uses, extended
from file locality to symbol identity.

## Deferred (accepted limits)

- **Mined-incident symbol resolution.** Historical comments anchor by line only; a stale line degrades
  to a soft line-overlap match (never a durable sentinel). Resolving them to symbols would need the
  code graph at analyze time or a backfill pass.
- **Symbol-level co-change.** v1 propagation is file-level (the existing PPR neighbours). A symbol-level
  co-change graph is the upgrade if it earns its keep.
- **Line-level granularity.** Out — symbol is the unit. Revisit only if a real case demands it.

## The negative twin — location-scoped suppression (ADR-48)

Code-path memory anchors *positive* incidents (a fix/accept) to a symbol so a prior fix re-surfaces
as a regression sentinel. **Suppression** is the mirror: a *dismissal* (reject/waive/acknowledge) is
anchored to the same `file#name` key so it scopes to **that instance** instead of becoming a repo-wide
weight — dismiss one intentional `console.log` and the rule still surfaces at every other symbol. Same
key (`symbolKey`), same brain-finding resolution in `submitVerdict`, opposite polarity. See
[`negative-knowledge.md`](negative-knowledge.md) §"Location scope" and ADR-48. (One coupling worth
naming: deterministic findings now carry their enclosing symbol — `@plex/deterministic`
`enclosingSymbol` — so a codified rule like `no-console` can be symbol-scoped, not just agent findings.)

## The one-liner (for when you're explaining it)

> A linter checks the code in front of it. Plex remembers what your team already learned about *this
> code* — every concern raised at a symbol, whether it was fixed, and what changes alongside it — and
> tells you the moment you touch it again. Memory, grounded in your code graph, is the difference.
