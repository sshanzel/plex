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
| `acknowledge` | "intentional `note`" | not suppression-learning — the ADR-31 suppress-until-materially-changed path, unchanged |

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

## Built in ADR-41 (was deferred here)

- **Decay** ✅ — `loadSuppressions` recency-decays each dismissal (`0.5^(ageDays/halfLife)`, wall-time)
  and feeds the *decayed fractional* counts into the unchanged Wilson `suppressionTier`. Verb-specific
  half-life (`reject` fades, `waive` persists; corrections durable). This is also the re-surface
  mechanism — an aged suppression's effective N shrinks → the tier slides `suppress→demote→surface`.
- **Re-surface probe** ✅ DROPPED — subsumed by decay (above); `suppressed` already sinks (not deletes).
- **First-principles suppression** ✅ — a finding with no key is keyed by its **title embedding**:
  match-or-mint a negative pitfall by cosine ≥ `adaptiveFloor(0.82,…)`, and rank via synthetic
  `pattern-repo` semantic waivers (reuses `waiverMatches`). Embedding-gated; `suppress`-tier only.
- **Verb upgrade on re-dismissal** ✅ — the `(pitfall, file)` dedup is *verb-aware*, not flat. A
  dismissal still counts once per file, but a `waive` ("this is wrong") recorded over a prior `reject`
  ("not now") on the same file is allowed through as an **upgrade** — `learnSuppression` records it,
  and `countsOf` collapses the pair back to one vote carrying the **stronger** verb (so the half-life
  jumps 30d→365d and the suppression actually starts persisting). The upgrade is strictly monotone: a
  `reject` after a `waive` carries no new information and is dropped (never a downgrade). Without this,
  a user escalating reject→waive on the identical finding kept the short 30d decay and could never make
  it stick.

The one accepted tuning knob is the decay half-life (`config.suppression`, reject 30d / waive 365d) —
reachable via `~/.plex/config.json` (`"suppression": { "rejectHalfLifeDays", "waiveHalfLifeDays" }`,
partial blocks merge with defaults) or `PLEX_SUPPRESSION_REJECT_HALFLIFE_DAYS` /
`PLEX_SUPPRESSION_WAIVE_HALFLIFE_DAYS`.

**Two intended consequences worth naming (so they aren't read as bugs):**

- **The `(pitfall, file)` dedup gives first-principles a lower evidence ceiling than deterministic —
  on purpose.** Each *distinct deterministic rule tag* is its own negative pitfall, so two different
  rules firing in one file each count their own dismissal. First-principles findings instead match by
  cosine ≥ 0.82, so two *near-but-distinct* findings in the same file collapse onto the same negative
  pitfall and the `(pitfall, file)` guard counts them once. That's not a leak — at that cosine they
  *are* "the same issue" by our matching definition, and the guard is the drift-stability that keeps a
  line-rekeyed or reworded finding from double-counting (same tradeoff as `inferPitfallId`). Accruing
  to the `suppress` bar across *different files* is unaffected. **(ADR-48 refines this dedup to
  `(pitfall, file, symbol)`** — see below.)
- **A first-principles suppression silently no-ops on a per-review embed failure (it doesn't degrade —
  it vanishes for that review).** The synthetic `pattern-repo` waiver carries *only* an embedding, so
  if `safeEmbed` returns nothing that round, findings go unembedded, `waiverMatches`'s semantic branch
  is false, and the suppression simply doesn't apply — reappearing the next review once embeds
  recover. There is no identity fallback because a first-principles suppression *is* its embedding
  (unlike a tag-keyed waiver). Deterministic suppression is unaffected — consistent with the
  embeddings-optional posture: off, not broken.

## Location scope — symbol-scoped suppression (ADR-48)

Everything above governs **whether** a rule is suppressed (the Wilson tier) and **how long**
(recency decay). ADR-48 adds an orthogonal dimension: **where**. A dismissal is the *negative twin*
of code-path memory (`docs/design/code-path-memory.md`) — it anchors to the `file#name` **symbol** it
concerned, so suppression scopes to that location instead of becoming a repo-wide weight.

The motivating bug: dismiss one intentional `console.log` ("it's the CLI logger") and the old
repo-wide behavior demoted/suppressed `no-console` *everywhere* — the next genuinely-stray
`console.log` was silently buried. The user's intent: *don't re-ask about that instance, but keep
surfacing the rule elsewhere.*

**How it works.**
- **Capture.** `submitVerdict` resolves the dismissed finding's `symbol`+`line` from the brain
  `Finding` (by `findingId`) — hoisted above `recordVerdict`/`learnSuppression` so reject/waive/
  acknowledge all inherit it — and `learnSuppression` records the negative incident **with** that
  symbol. An **explicit** repo-wide scope (`pattern-repo`/`category-*` — "this rule, everywhere") is
  recorded **symbol-less** on purpose.
- **Dedup → `(pitfall, file, symbol)`.** Both the write-side guard (`learnSuppression`) and the
  read-side vote grouping (`countsOf`) key on the symbol now: line-drift within one symbol still
  collapses to a single Wilson vote (the key is drift-tolerant), but two genuinely distinct instances
  at different symbols in the same file each count. A symbol-less incident keys on `file\0` — identical
  to the old per-file grouping, so legacy/repo-wide evidence is unchanged.
- **Derive.** `loadSuppressions` puts `repoWide` + `symbols` on each `SuppressionDecision`. It's
  `repoWide` iff **any** contributing incident is symbol-less (explicit scope, a legacy record, or a
  `findingId`-less verdict) — **fail-open** to the pre-ADR-48 behavior, never more aggressive than
  intended. Otherwise it's scoped to the collected `file#name` set. First-principles (embedding) and
  cross-repo-promoted decisions stay repo-wide in v1.
- **Apply.** `rankFindings`'s `learnedSuppression` suppresses a finding iff
  `repoWide || symbols.has(symbolKey(f.location.file, f.location.symbol))`. A symbol-scoped decision
  that doesn't match the finding's symbol leaves it surfacing.
- **Deterministic findings now carry a symbol.** The TS-AST walker (`@plex/deterministic`
  `analyzeSource`) resolves each finding's nearest enclosing named declaration (`enclosingSymbol`)
  onto `Finding.location.symbol`. Without this the `no-console` rule — the motivating case — had no
  symbol and would have stayed repo-wide. The name is stable across rounds (re-derived from the same
  AST); it needn't match the code graph's `Class.method` qualification, only itself.
- **The `acknowledge`/`waive` waiver path** is tightened the same way: `Waiver` gains `symbol?`,
  `submitVerdict` persists it, and `waiverMatches` symbol-gates the `file`/`line` scopes (a
  symbol-carrying waiver matches only the same `file#name`; a symbol-less one keeps pure file/line
  matching; pattern/category semantic scopes are untouched).

**Backward-compatible by construction.** Every pre-ADR-48 dismissal incident is symbol-less → reads as
`repoWide`; a verdict with no resolvable symbol fails open the same way. No migration, no backfill. The
Wilson "weighted, never a one-click kill" property is preserved — symbol-scoping rides *on top of* the
tier, it doesn't lower the bar.

**Deferred (v1 limits):** first-principles (embedding-keyed) and cross-repo C2 suppressions stay
repo-wide (their identity is a title embedding / a cross-project rule, not a symbol); line-level
granularity is out (symbol is the unit); the deterministic enclosing-symbol is the nearest named
declaration (two same-named methods in one file could collide — rare, accepted).
