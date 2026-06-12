# Design note — learned suppressions (negative knowledge) + language-aware scope promotion

**Status:** **built** (all four build-order steps + provenance shipped; decay / re-surface probe /
first-principles suppression deliberately deferred — see below). Promote to ADR-39. Builds on
[`knowledge-decay.md`](knowledge-decay.md) (the weighting/aging machinery) and
[`outcome-signals.md`](outcome-signals.md) (richer outcome grades).

**Scoring is Wilson, not hand-tuned floors.** Both positive and negative pitfall confidence is the
**Wilson score lower bound** of the confirm rate (`@plex/knowledge` `wilsonLowerBound`), and the
suppress/demote decision is `suppressionTier` — two textbook confidence levels (95% / 1σ) against the
0.5 majority pivot, no invented constants. This replaced the earlier `REJECT_COST`/Beta-prior magic
on the positive path too (one estimator for both polarities). C1 ("a single dismissal can't bury a
finding") then holds *by construction*: ~4 consistent dismissals are needed to be 95%-confident.

## Problem — the knowledge loop only learns positives

The review loop is **one-directional**. Accepts learn; dismissals don't.

- **Accept** → `learnIncident({outcome:'accepted'})` → provenance `Incident` → `consolidatePitfalls`
  recomputes Beta confidence → scoped `repo`/`global` and retrieved on future reviews. A full
  **learn → consolidate → scope** loop (`engine/src/knowledge.ts`, `knowledge/src/promotion.ts`).
- **Reject / waive** → only an **instance** waiver (`loadWaivers`, default `file` scope) + a brain
  `outcome:'rejected'` flag. **No incident, no consolidation, no scope.** `pattern-repo` /
  `category-global` are real waiver scopes but **nothing produces them** — there is no place in the
  product where a repo-wide suppression is created through the normal flow.

Two consequences:

1. **Deterministic rules can never be silenced by use.** A codified rule (e.g. `no-console`,
   the late `no-await-in-loop`) has *no pitfall backing*, so rejecting it touches no confidence at
   all — it re-fires at full strength every review. This is the complaint that started this thread.
2. **The "secondary per-repo brain" never learns what to STOP surfacing.** It accumulates positive
   knowledge and ages it (decay, proposed) but has no negative half. It is not "practically the
   same as the regular brain" until dismissals flow through the same loop.

The fix: make a **suppression a first-class "negative pitfall"** that flows through the *same*
incident → consolidate → scope path as a positive one. One store, two polarities, one learning loop.

## Two hard constraints (non-negotiable, from the product owner)

### C1 — A dismissal is *weighted*, never a permanent kill

> "What I don't want is: the user dismissed it now, then it's never surfaced again. Maybe they
> wanted to dismiss it now but will fix it in a following PR."

A single dismissal means **"not now,"** not "wrong forever." So:

- **One reject must NOT create a hard waiver.** (Today it does — `loadWaivers` lumps `reject` with
  `waive`. That is exactly the behavior this design revises.)
- Suppression strength **accumulates** from *repeated, consistent* dismissals and **decays** when
  they stop (the [`knowledge-decay.md`](knowledge-decay.md) half-life model, reused). The
  "I'll fix it next PR" path self-corrects: if you fix it, negative evidence stops accruing and it
  never promotes; if you keep dismissing it, it earns suppression.
- Suppression is **graded, not binary** (see the demote tier below): a weak signal *down-ranks* a
  finding (still visible, lower); only a strong, sustained signal moves it to the `suppressed`
  bucket — and even then a **probe cadence** re-surfaces it occasionally (or on material code
  change) so a wrong suppression is recoverable. Suppression must never become a silent black hole.

### C2 — Global promotion is *language-aware*

> "We can't have language-specific rules go global. A user commonly has multiple repos in different
> languages."

The deterministic layer is **TS/JS-only** (ADR-15), and most pitfalls reference language-specific
APIs/syntax. Promoting any of those to a language-blind `global` would leak a TS rule into a Python
repo. So:

- Knowledge entries (positive **and** negative) carry a **`language`** dimension.
- `global` splits into **language-scoped global** ("applies to every repo of language L") vs
  **language-agnostic global** ("an architectural/logical flow that holds everywhere").
- A deterministic-rule suppression is inherently `lang: ts/js` and may at most promote to
  **global-for-ts** — never agnostic-global.
- Agnostic-global is **opt-in / certified, never auto-inferred** from recurrence. Default everything
  language-scoped; only a pattern explicitly certified language-neutral (no language-specific
  API/syntax — an LLM or human call at distillation) earns agnostic-global.
- **Retrieval gates on language**: a review in a Python repo never retrieves `ts`-scoped knowledge
  (positive or negative). Extends the ADR-21 scope filter with a language predicate.

## Design

### 1. Negative incidents (the producer that's missing)

A dismissal records an `Incident` with a negative outcome, keyed by a **stable suppression key**:

- deterministic finding → the **rule tag** (`no-console`) — already on `Finding.tags`.
- knowledge/first-principles finding → the **pitfall id**, else a normalized title/pattern.

Distinguish the verbs by evidence weight (don't collapse them):

| Verb | Meaning | Evidence |
|---|---|---|
| `waive` | "false positive — this is wrong" | **strong** negative |
| `reject` | "dismissed / not now" | **weak** negative (C1's case) |
| `acknowledge` | "intentional `awareness` flag" | not suppression-learning — the ADR-31 suppress-until-materially-changed path, unchanged |

A later **accept/fix** of the same key is **negative-of-negative** evidence — the suppression was
wrong; it should rapidly lose confidence (a strong corrective, like `outcome-signals.md`'s
`reverted` bonus but inverted).

### 2. Weighted suppression via consolidation (no hard kill — satisfies C1)

A negative pitfall carries Beta-derived `confidence` from its dismissal incidents (positive
evidence = dismissals, weighted by verb; negative evidence = later accepts/fixes), **decayed** by
time/review-count since last reinforcement (shared with the decay design). Ranking reads it by tier:

- below `demoteFloor` → **surface** (a lone "not now" changes nothing structural yet);
- `demoteFloor ≤ c < suppressFloor` → new **`demoted`** triage tier (between `surface` and
  `convention`): still in the stream, ranked low — the "I keep skipping this but haven't decided"
  zone;
- `c ≥ suppressFloor` **and** sustained → **`suppressed`**, i.e. a real repo-wide waiver, *with* a
  probe cadence / material-change re-surface so it's never permanent-blind.

`waive` (explicit false-positive) may still fast-path to `suppressed` for its **own instance**
immediately (that's a correct UX — a known false positive shouldn't nag mid-PR); what it must NOT
do is silently become a *repo-wide* rule from one click. Repo-wide is earned by consolidation.

### 3. Scope promotion, language-gated (satisfies C2)

Promotion runs in consolidation, mirroring positive↔negative:

- A `repo`-scoped entry whose key recurs across **≥N distinct repos of the same language** →
  **language-scoped global** (`global@ts`).
- **Cross-language** recurrence promotes to **agnostic-global only if certified** language-neutral
  (default: stays language-scoped; never auto-agnostic).
- Retrieval (`retrieveRelevant`) and waiver emission filter by `(scope, language)` against the repo
  under review.

"Common pitfalls feed other repos" already works for today's `global` pitfalls — this adds the
**promotion path** (repo proves general → graduates) and the **language guard** that makes it safe.

## Reconciliation with existing/proposed pieces

- **`knowledge-decay.md`** — this design *depends* on decay for C1's "weighted, not permanent."
  Build them together; the half-life/clock open questions (wall-time vs review-count) apply to
  negative pitfalls identically.
- **`outcome-signals.md`** — a richer `fixed` signal sharpens negative-of-negative ("dismissed then
  fixed" = suppression was wrong).
- **The recent context-side waiver filter** (`review.ts` step 6) currently inherits the *old*
  hard-suppress-on-reject semantics (it filters by `loadWaivers`, which includes `reject`). Under
  this design that becomes: filter by `waive`/`acknowledge` (hard) but let `reject` flow through the
  weighted `demoted`/`suppressed` tiers instead. **Interim option:** drop `reject` from the context
  filter now (keep `waive`/`acknowledge`) so we don't ship a permanent-kill that contradicts C1,
  ahead of the full weighted path.

## Where it plugs in

- `packages/core/src/types.ts` — `Pitfall` gains `polarity: 'positive'|'negative'`, `language?`,
  `lastReinforcedAt?` (shared w/ decay); `Incident` gains the suppression `key` + `language`.
- `packages/knowledge/src/promotion.ts` — consolidate negative pitfalls; language-gated repo→global
  promotion.
- `packages/knowledge/src/retrieve.ts` — `(scope, language)` retrieval gate; negative pitfalls
  emitted as waivers tiered by confidence.
- `packages/findings/src/rank.ts` — new **`demoted`** triage tier (weighted suppression).
- `packages/engine/src/knowledge.ts` (`submitVerdict`) — reject/waive → negative incident keyed by
  the suppression key; stop minting a hard waiver from a single reject.
- `packages/engine/src/verdicts.ts` (`loadWaivers`) — `reject` leaves the hard-waiver set; ranking
  consults negative-pitfall confidence instead.
- `packages/core/src/config.ts` — `demoteFloor`, `suppressFloor`, promotion `minRepos`, probe
  cadence, language-detection knobs.

## Open questions / tuning

- **Thresholds & priors.** Dismissals → `demoted` → `suppressed`. Beta prior on a negative pitfall;
  how strongly `waive` outweighs `reject`; how fast accept/fix corrects.
- **Probe cadence for a suppressed rule.** Every K reviews? Only on material (semantic) change to
  the region? Both — re-surface on change, plus a slow time probe.
- **Language detection.** File extension is the cheap signal; a mixed-language repo and a
  cross-language pitfall need a rule (per-incident language; an entry can be multi-language).
- **Agnostic-global certification.** Keep strict — default language-scoped; agnostic only on an
  explicit certify step, never recurrence alone.
- **Migration.** Replay existing `reject` verdicts as seed negative incidents, or start fresh?

## Build order (when promoted to ADR-39)

1. ✅ **Negative incidents + the `reject`/`waive` producer** — `learnSuppression` (engine
   `knowledge.ts`), called from `submitVerdict`: a dismissal of a finding with a stable suppression
   key (`det:<rule>` id or explicit pattern) records a confirming incident on a repo-scoped negative
   pitfall; an accept refutes it. Retry-deduped via `firstOfKind`.
2. ✅ **The weighted `demoted` tier** — `rankFindings` gains a `suppressions` map; `loadSuppressions`
   computes `suppressionTier` live from incident counts (fresh without a `consolidate` run).
   `demoted` sits between `convention` and `suppressed`. Interim context-filter softening shipped
   (`loadWaivers` honors only `waive`/`acknowledge` for the up-front prime).
3. ✅ **Consolidation → earned repo-wide suppression** — polarity-aware Wilson in `consolidatePitfalls`
   (a dismissal confirms, an accept/fix refutes); `suppressionTier` decides suppress vs demote.
4. ✅ **Language-gated cross-repo promotion (C2)** — computed LIVE in `loadSuppressions` (no persisted
   global entity, no incident duplication, no stale state): a key that earned `suppress` in ≥
   `PROMOTE_MIN_REPOS` (2) distinct repos **of the same language** generalizes. Grouping by language
   means TS and Python never merge, and — because a deterministic rule tag is itself language-bound —
   a promoted `global@ts` decision can only ever match TS findings. **No** language-blind auto-promotion
   (agnostic-global stays certified-only). `PROMOTE_MIN_REPOS` is a POLICY floor (how many independent
   projects before generalizing is a risk choice), explicitly *not* a statistical one — kept ≥2 so one
   repo can't self-promote.

**Provenance (history of WHY a rule is listed).** Three layers: the brain's `Verdict` nodes hold the
raw dismissals per round; each knowledge `Incident` carries a `note` with the originating verb
(`reject`/`waive`) + finding id that `outcome:'rejected'` alone loses; and the audit log's
`findings_submitted` event records the `suppressions` active for the review with their
dismissal/correction counts and Wilson tier. So "why is `no-console` suppressed here?" is answerable
end to end.

## Deliberately deferred (and why)

- **Decay + re-surface probe** — both need a tuning **constant** (a half-life, or a "re-surface every
  K reviews" cadence). Introducing one would reintroduce exactly the hand-tuned magic this effort
  removed in favor of Wilson, so they're *not* built unsilently. Note the recovery path already
  exists WITHOUT a probe: `suppressed` **sinks to the bottom of the stream, it is not deleted** — a
  user who disagrees can still see and `accept` it, and one accept (a correction) drops the Wilson
  tier. A time-based probe/decay is a UX refinement to decide on explicitly (it costs a constant).
- **Knowledge-finding (first-principles) suppression** — only deterministic rules + explicit patterns
  have a stable suppression key today; a first-principles finding's identity is "a line of code," so
  repo-wide suppression would need semantic matching (ADR-27 territory) with its own false-positive
  risk. Separate feature.
