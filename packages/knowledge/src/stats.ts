/**
 * Statistical primitives for outcome-driven knowledge confidence (ADR-39; tuning.md §1). Pitfall
 * confidence (both polarities) and the suppression tier rest on the Wilson score lower bound.
 */
import type { IncidentOutcome } from '@plex/core';

/**
 * Wilson score lower bound of a binomial success rate (Wilson 1927) — discounts a lucky 1/1 toward 0
 * and tightens to the raw rate as evidence accrues, so a thin sample never outranks a proven one.
 * `z=1.96` ≈ 95%. Returns 0 for n≤0.
 */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (center - margin) / denom);
}

/**
 * A POSITIVE pitfall's confidence: the Wilson lower bound of the confirm rate (ADR-44; the same estimator
 * `consolidatePitfalls` uses — one definition everywhere). Confirm = `accepted`/`fixed`/`reverted`; refute
 * = `rejected`; everything else ABSTAINS (observed-but-uninformative, dropped rather than a fabricated
 * confirm). Zero informative evidence → 0 (honest floor; retrieval floors the tilt so it still surfaces).
 *
 * POSITIVE pitfalls ONLY (no `polarity` switch). Do NOT feed a negative pitfall's outcomes here — it would
 * read a dismissal as a refute and invert; negatives get their tier from `suppressionTier`.
 */
export function confidenceFromOutcomes(
  outcomes: ReadonlyArray<IncidentOutcome | undefined>,
  corroboratedWeight: number = CORROBORATED_WEIGHT,
): number {
  let confirms = 0;
  let refutes = 0;
  for (const o of outcomes) {
    if (o === 'accepted' || o === 'fixed' || o === 'reverted') confirms += 1;
    else if (o === 'corroborated') confirms += corroboratedWeight; // weak confirm (ADR-50)
    else if (o === 'rejected') refutes += 1;
  }
  return wilsonLowerBound(confirms, confirms + refutes);
}

/**
 * Evidence weight of a `corroborated` confirm (ADR-50) — a reply-agreement signal worth a fraction of an
 * observed code change (weight 1). A SINGLE named constant, NOT a per-outcome table (ADR-44 deleted the
 * magic `outcomeWeight` 1.5 bonus; strong confirms stay 1.0).
 */
export const CORROBORATED_WEIGHT = 0.5;

/** Standard-normal critical values — the two textbook confidence levels, NOT tuned knobs. */
export const Z_95 = 1.96; // 95% — the level at which we commit to a repo-wide suppression
export const Z_68 = 1.0; //  ~68% (1σ) — the weaker level at which we merely DEMOTE

export type SuppressionTier = 'suppress' | 'demote' | 'none';

/**
 * How strongly a stream of dismissals justifies suppressing a finding (Wilson lower bound at 95%/1σ vs
 * the 0.5 majority pivot). Robust to small N by construction: one "not now" can never bury a finding (C1);
 * ~4 consistent dismissals → suppress, 1–3 → demote. `dismissals` = waive+reject; `corrections` = accept/fix.
 */
export function suppressionTier(dismissals: number, corrections: number): SuppressionTier {
  const total = dismissals + corrections;
  if (total <= 0) return 'none';
  if (wilsonLowerBound(dismissals, total, Z_95) >= 0.5) return 'suppress';
  if (wilsonLowerBound(dismissals, total, Z_68) >= 0.5) return 'demote';
  return 'none';
}

/** Per-verb half-lives (days) for dismissal recency-decay. Corrections are durable (no knob). */
export interface DecayHalfLives {
  /** `reject` ("not now") fades fast. */
  rejectDays: number;
  /** `waive` ("this is wrong") persists. */
  waiveDays: number;
}

/** One aged dismissal: its verb (sets the half-life) and age in days. */
export type Dismissal = { verb: 'reject' | 'waive'; ageDays: number };

/**
 * Exponential recency weight: `0.5^(ageDays / halfLifeDays)`. A non-positive OR non-finite half-life
 * means "never decays" (weight 1) — keeps the function TOTAL (0 → no `0.5^Infinity`, negative → no
 * inverted decay; a misconfigured half-life degrades to no-decay, never NaN). Negative ages clamp to 0.
 */
export function recencyWeight(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

/**
 * Decay the suppression evidence by recency (ADR-41): each dismissal contributes `recencyWeight`
 * (verb-specific half-life — reject fades, waive persists). INVARIANT: corrections are DURABLE (full
 * weight 1) — acting on a finding is permanent evidence, must not fade and let a stale suppression creep back.
 */
export function decayedCounts(
  dismissals: Dismissal[],
  correctionsCount: number,
  hl: DecayHalfLives,
): { dismissals: number; corrections: number } {
  const d = dismissals.reduce((s, x) => s + recencyWeight(x.ageDays, x.verb === 'waive' ? hl.waiveDays : hl.rejectDays), 0);
  return { dismissals: d, corrections: correctionsCount };
}
