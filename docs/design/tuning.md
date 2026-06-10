# Tuning record — the weights, thresholds, and their basis

**Status:** living reference. The single place that records *every* numeric knob Plex ships, its
current value, where it lives, and **whether it rests on a formula or on intuition**. Until now this
was scattered across code comments + ADRs + git history; this consolidates it so the experimentation
is tracked, not rediscovered.

> **Principled-tuning rehaul (adopted).** A literature pass (with verified citations) replaced five
> hand-tuned mechanisms with their textbook forms — each a tested commit:
> 1. **Pitfall confidence → Beta-Bernoulli posterior mean + Wilson lower bound** (was `±0.1/±0.15`).
> 2. **Co-change strength → Salton association strength** `co/√(degA·degB)` (was a raw count; removes the frequency confound).
> 3. **Clustering cut → adaptive `μ+kσ` of the batch's own cosines** (was a fixed `0.8`).
> 4. **Blast radius → personalized PageRank / RWR**, degree-normalized — *subsumes* the hub-damping (was BFS + `hubWeight`).
> 5. **Ranking → an nDCG eval metric** over outcome labels (live verdicts **or analyzed PR history**) — the measuring stick the weights need.
>
> What remains genuinely empirical / deferred is called out per-section and in **The honest limit** below.

## How a change is recorded (the "basis/record" answer)

There is no separate experiment DB — the record is **git history + ADR notes + this file**:

1. **git** — every weight change is a commit; the message carries the rationale.
2. **ADRs** — model-level decisions (separate severity/confidence axes — ADR-04; prevalence-by-severity
   — ADR-05; coupling sources + hub-damping — ADR-06; semantic waivers — ADR-27). When a change alters
   the *model* (not just a magnitude), add an ADR or a `Refinement` note (see ADR-06/ADR-28 for the pattern).
3. **this file** — update the value + a one-line "why" whenever a knob moves, so the current state is
   readable in one place.

## Two kinds of knob

- **Principled** — backed by an established formula/result; the value follows from it.
- **Empirical** — no formula applies (it's a magnitude or a model-specific cutoff); tuned by intuition
  and only rigorously settable with an **evaluation harness** (see bottom).

---

## Blast radius / neighborhood — `packages/neighborhood/src/compute.ts`

| Knob | Value | Exposed | Basis | Why |
|---|---|---|---|---|
Propagation is **personalized PageRank / random-walk-with-restart** (Page 1999; PPR ≡ RWR), seeded on
the changed files over CoChange ∪ Imports ∪ Refs. The walk's transition is **degree-normalized** — a
node forwards its mass split across its out-edges by weight — so a hub (barrel/registry) dilutes
natively. That **subsumes** the old `hubWeight` (removed) and the per-hop decay.

| Knob | Value | Exposed | Basis | Why |
|---|---|---|---|---|
| `maxHops` | 2 | config | empirical | RWR iteration cap; 1 misses transitive coupling, 3+ widens the radius. |
| `maxNeighbors` | 40 | config | empirical | output/token cap on the radius. |
| `minScore` | 0.05 | config | empirical | floor (of the max-normalized PPR score) that drops trace coupling. |
| `restart` | 0.15 | hardcoded | **principled** | RWR teleport / damping `d = 0.85` — the PageRank convention. |
| `importWeight` | 0.4 | hardcoded | empirical | relative edge weight: a structural import is weaker than co-change. |
| `refWeight` | 0.5 | hardcoded | empirical | a precise alias-ref slightly stronger than a bare import. |
| ~~`hubThreshold`~~ | — | removed | **principled (PPR)** | the structural-hub fix is now intrinsic to the degree-normalized walk; no separate knob (PPR's random-walk normalization is the proper form of the IDF intuition the old `min(1,threshold/degree)` approximated). |

## Co-change (logical coupling) — `config.coChange`, `packages/code-graph`

| Knob | Value | Basis | Why |
|---|---|---|---|
| `maxCommitFiles` | 25 | **principled** | a commit touching >N files is a sweep, not coupling — standard co-change denoising (Zimmermann et al., *Mining Version Histories*; ADR-06). |
| `halfLifeDays` | 365 | **principled** (form) / empirical (value) | exponential recency decay — standard; the 1-year half-life itself is a guess. |
| `minPairCount` | 2 | **principled** | a pair must recur to count — kills singleton N² noise (ADR-06). |
| `maxCommits` | 5000 | empirical | history-crawl budget. |
| pair strength | `co / √(degA·degB)` | **principled (adopted)** | **Salton association strength** (van Eck & Waltman 2009) over co-change degrees — divides out each file's promiscuity, so a config/lockfile/barrel that co-changes with everything collapses toward 0. The read-time, no-marginal-storage form of association-rule **lift** (Gall 1998; Zimmermann 2004); applied in `neighborhood/compute.ts`, stored weight untouched (ADR-26 incremental safe). |
| confidence merge | `1−(1−a)(1−b)` | **principled** | noisy-OR: independent sources agreeing raise confidence (`dedupe.ts`). |

## Ranking / signal — `packages/findings/src/signal.ts`, `rank.ts`

`signal = severityWeight × confidence × blast × deviation × agreement` — a **heuristic multiplicative
model** (defensible, but not a canonical formula; the structure encodes ADR-04/05).

| Knob | Value | Basis | Why |
|---|---|---|---|
| severity weights | bug 1 · improvement 0.5 · nit 0.2 · awareness 0.3 | empirical | relative importance. |
| `blast` | `0.5 + 0.5·blast` | empirical | a no-blast finding is dampened, never zeroed. `blast` is now **auto-enriched** from the neighborhood sidecar (no longer dormant — see "Blast enrichment" below). |
| `deviation` | bug→1; else `1 − 0.8·prevalence` | **principled (ADR-05)** | prevalence demotes style, **never a bug** (a common bug is systemic). |
| `agreement` | `1 + 0.15·(sources−1)` | empirical | cross-source corroboration boost. |
| prevalence threshold | 0.5 | empirical | at/above ⇒ "codebase norm". |

## Fix inference (autonomous accept) — `packages/findings/src/rounds.ts` (ADR-28)

| Knob | Value | Basis | Why |
|---|---|---|---|
| `semanticThreshold` | 0.6 | **empirical (model-calibrated)** | cosine cutoff for "a change addressed this finding" — tied to the embedding model's geometry. |
| `lineWindow` | 5 | empirical | drift tolerance for the locality signal; **tightened from 30** after a live false-accept (a churning file made any nearby edit auto-accept — C-G2). |

## Waivers + knowledge — `packages/engine/src/findings.ts`, `packages/knowledge`

| Knob | Value | Basis | Why |
|---|---|---|---|
| `WAIVER_SEMANTIC_THRESHOLD` | 0.82 floor | **adaptive — safe-direction (adopted)** | a waiver suppresses cosine-≥ findings. Now `max(0.82, μ+3σ)` of the batch's cosine background (`adaptiveFloor`) — on an anisotropic model the bar rises so it suppresses *less*; it can never fall below 0.82, so it never hides more than the fixed value did. |
| `semanticThreshold` (fix-inference) | 0.6 floor | **adaptive — safe-direction (adopted)** | the auto-accept cut, `max(0.6, μ+3σ)` of the region/finding background — rises (auto-accepts *less*, surfaces *more*) on a high-baseline model, never below 0.6. With no embedder → background {0,0} → stays 0.6, locality unaffected. |
| `analyze.clusterThreshold` | **adaptive** `μ+kσ` | **principled (adopted)** | the cut is now estimated from the **batch's own** pairwise-cosine background (`adaptiveCosineThreshold`, k=3) — a pair clusters only if it's k σ above this batch's typical pair, auto-adapting per model. The configured `0.8` is the small-batch (n<8) fallback. Anisotropy makes a fixed cutoff fragile (Mu & Viswanath 2018; Su 2021); estimating from data sidesteps it with no stored corpus. |
| pitfall confidence | **Beta-Bernoulli** posterior mean | **principled (adopted)** | `confidence = (α0+s)/(α0+β0+s+1.5f)` with prior Beta(1,1) and rejects at 1.5× (was `±0.1/±0.15`). Idempotent, no clamp-loss, no path-dependence. `wilsonLowerBound` (Wilson 1927) available for small-sample ranking. `promotion.ts`. |
| ~~promotion threshold~~ | — | removed | the markdown-promotion direction (graph → `plex.md`) was retired with `plex.md` (ADR-37); rule promotion gates on `tier === 'codifiable'`, not confidence. |

## Review plan (fan-out) — `config.reviewPlan` (ADR-34)

`minFiles 6 · minSurface 150 · maxAgents 5 · minClusterFiles 2` — all **empirical**; conservative so a
small/tightly-coupled change stays a single pass.

---

## The honest limit — and what's left

The **ranking magnitude knobs** (severity weights, import/ref edge weights, the `blast`/`agreement`
shapes) have **no closed-form correct value** — they encode a preference (the multiplicative form is a
legitimate Weighted Product Model; only the relative weights are free). You cannot derive them; you can
only *fit* them against labeled relevance.

That measuring stick now exists: **`ndcg` / `rankingNdcg`** (`findings/src/eval.ts`) scores a ranking
against outcome labels. And the labels exist two ways — live `record_outcome` verdicts, and, at scale,
**analyzed PR history** (every review comment is a finding a human cared about; its outcome grades it; the
analysis pipeline already pulls comment → outcome). So the path is concrete:

**Measurement is wired (adopted).** `rankingQuality` (`engine/ranking-eval.ts`, surfaced as `plex eval`)
reads the brain's per-finding `signal` + raw features + outcome — data the review flow already persists,
**analysis-independent** — and reports the current ranking's nDCG vs what the user actually accepted, per
evaluable round. It is **measurement only** (never mutates weights) and is the guard that answers, for
*this* user's accrued data, whether a re-weight could even beat the defaults. If the data is sparse it
says so and the defaults stand.

**Readiness verdict (adopted).** `plex eval` no longer just prints numbers — it emits an explicit
**`READY` / `NOT YET` / `DEFAULTS ALREADY WIN`** verdict for deferred #1, from a pure, unit-tested gate
(`rankingReadiness`, `findings/eval.ts`). The gates, in priority order, are the honest floor for *being
able to fit at all* then *being worth fitting*: ≥`minEvaluableRounds` (25) for grouped held-out CV →
≥`minPositives` (50, the EPV rule: ≈10 per feature) → both label classes present
(`minMinorityShare` 0.2 / `minNegatives` 10) → current nDCG **below** `headroomNdcg` (0.85, else the
defaults already win). `READY` means *build a candidate* — which must still beat the defaults on grouped
held-out CV before shipping (that CV harness is step 1 of #1, below). A near-constant feature (e.g. blast
on a small-change repo) is flagged so the fit drops it.

**Adaptive suppression thresholds (adopted).** `WAIVER_SEMANTIC_THRESHOLD` and the fix-inference cut are
now `adaptiveFloor`-adapted upward-only (above) — the safe-direction calibration, so a per-model
baseline shift can only make them suppress *less*, never hide more.

**Blast enrichment + feature persistence (adopted).** Blast is no longer dormant. At
`get_review_context` time — while the code graph is *already open* for the neighborhood, so **no extra
Kùzu open** at `submit_findings` (respecting the ADR-17 open-limit) — the review computes a per-file
`blast` map (changed files: batch-relative File↔File coupling centrality via `getCouplingDegrees`;
neighbors: their PPR score) and writes it to a `blast-map.json` sidecar keyed by `reviewTargetFor`. At
rank time `rankReviewFindings` enriches each finding's `blastRadius` from that sidecar (respecting an
agent-supplied value; best-effort — no sidecar ⇒ unchanged). The brain's `Finding` then **persists the
raw features** `blast`/`prevalence`/`agreement` (idempotent `ALTER TABLE … ADD … DEFAULT` migration for
pre-existing brains; an unset feature stores as `0`/`1`), and `Brain.rankingSamples()` returns them — so
the deferred re-weight has real, analysis-independent feature vectors to fit. **Measurement/plumbing only:
the `signal` formula is unchanged** (a small/uncoupled change still floors blast near 0 ⇒ existing
rankings move only where coupling is genuinely high).

**Still deferred (needs accrued data, not a formula):**
1. **The actual ranking re-weight.** Fit the Weighted-Product exponents / a logistic model to maximize
   `rankingQuality`'s nDCG over the now-persisted feature vectors, then ship only if it beats the
   defaults on held-out data. Weights stay **global + pooled across the user's reviews + feature-
   normalized** (so uneven repos / repos that don't run analysis contribute comparably). Needs enough labeled
   review→outcome history to generalize — `plex eval` is the go/no-go guard.

Until that lands: change one knob at a time, record the rationale here + in the commit, prefer the
formula-backed shape (PPR, association strength, Beta-Bernoulli, recency-decay, noisy-OR) wherever one
exists, and use `plex eval` to check the data is rich enough before touching the ranking weights. **Sources** (verified): Wilson 1927; Evan Miller, *How Not To Sort By Average Rating*; Page 1999
(PageRank) / personalized-PageRank ≡ RWR; van Eck & Waltman 2009 (co-occurrence normalization); Gall 1998
& Zimmermann 2004 (logical coupling / lift); Mu & Viswanath 2018 & Su 2021 (embedding anisotropy);
Järvelin & Kekäläinen 2002 (nDCG); Weighted Product Model.
