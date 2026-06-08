# Tuning record — the weights, thresholds, and their basis

**Status:** living reference. The single place that records *every* numeric knob Plex ships, its
current value, where it lives, and **whether it rests on a formula or on intuition**. Until now this
was scattered across code comments + ADRs + git history; this consolidates it so the experimentation
is tracked, not rediscovered.

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
| `maxHops` | 2 | config | empirical | 1 hop misses transitive coupling; 3+ explodes the radius. |
| `maxNeighbors` | 40 | config | empirical | output/token cap on the radius. |
| `minScore` | 0.05 | config | empirical | floor that drops trace-coupling noise. |
| `importWeight` | 0.4 | hardcoded | empirical | a structural import is a weaker signal than co-change. |
| `refWeight` | 0.5 | hardcoded | empirical | a precise alias-ref is slightly stronger than a bare import. |
| `hopDecay` | 0.5 | hardcoded | empirical | each hop halves contribution. |
| `hubThreshold` | 20 | hardcoded | **principled (IDF)** | **inverse-popularity damping.** A node connected to many files is a diffuse hub (barrel/registry), not coupling — the same intuition as TF-IDF's `idf = log(N/df)`. We ship a **bounded approximation** `min(1, threshold/degree)` (full ≤ threshold, then `1/degree` falloff); the formal `log(N/df)` is the upgrade if we want strict grounding (ADR-06 refinement). |

## Co-change (logical coupling) — `config.coChange`, `packages/code-graph`

| Knob | Value | Basis | Why |
|---|---|---|---|
| `maxCommitFiles` | 25 | **principled** | a commit touching >N files is a sweep, not coupling — standard co-change denoising (Zimmermann et al., *Mining Version Histories*; ADR-06). |
| `halfLifeDays` | 365 | **principled** (form) / empirical (value) | exponential recency decay — standard; the 1-year half-life itself is a guess. |
| `minPairCount` | 2 | **principled** | a pair must recur to count — kills singleton N² noise (ADR-06). |
| `maxCommits` | 5000 | empirical | history-crawl budget. |
| confidence merge | `1−(1−a)(1−b)` | **principled** | noisy-OR: independent sources agreeing raise confidence (`dedupe.ts`). |

## Ranking / signal — `packages/findings/src/signal.ts`, `rank.ts`

`signal = severityWeight × confidence × blast × deviation × agreement` — a **heuristic multiplicative
model** (defensible, but not a canonical formula; the structure encodes ADR-04/05).

| Knob | Value | Basis | Why |
|---|---|---|---|
| severity weights | bug 1 · improvement 0.5 · nit 0.2 · awareness 0.3 | empirical | relative importance. |
| `blast` | `0.5 + 0.5·blast` | empirical | a no-blast finding is dampened, never zeroed. |
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
| `WAIVER_SEMANTIC_THRESHOLD` | 0.82 | **empirical (model-calibrated)** | a waiver suppresses cosine-≥ findings; calibrated to voyage-code-3 (related ~0.86, unrelated ~0.40 — `config.ts`). |
| `mining.clusterThreshold` | 0.8 | **empirical (model-calibrated)** | cluster tightness; <~0.7 sinks everything into one cluster. |
| consolidation | +0.1 accept/fixed · −0.15 reject | empirical | reject weighs more than accept (a false positive should cost more). |
| promotion threshold | 0.7 | empirical | confidence at which a pitfall is proposed for `plex.md`. |

## Review plan (fan-out) — `config.reviewPlan` (ADR-34)

`minFiles 6 · minSurface 150 · maxAgents 5 · minClusterFiles 2` — all **empirical**; conservative so a
small/tightly-coupled change stays a single pass.

---

## The honest limit — and the only rigorous fix

The **model-calibrated cosine cutoffs** (0.6 / 0.82 / 0.8) and the **magnitude knobs** (import/ref/hop
weights, severity weights, consolidation deltas) have **no closed-form "correct" value**. They were set
by intuition and are only as good as that intuition. Cosine thresholds are additionally **provider-specific**
— switching embedding models invalidates them (ADR-13), because each model places "related" and "unrelated"
at different cosines.

The principled way to move past guessing is **not** a formula but an **evaluation harness**: a labeled
corpus of diffs with known-good / known-bad findings (and known coupling), against which we measure
precision / recall / ranking quality (e.g. nDCG for the blast radius) as a knob changes — turning each
edit from "feels better" into a measured delta. That harness doesn't exist yet; it's the highest-leverage
investment for tuning, and the prerequisite for any auto-tuning. Until then: change one knob at a time,
record the rationale here + in the commit, and prefer the formula-backed shape (IDF, recency-decay,
noisy-OR) wherever one exists.
