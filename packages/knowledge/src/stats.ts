/**
 * Statistical primitives for outcome-driven knowledge confidence (see docs/design/tuning.md §1).
 *
 * Pitfall confidence (both polarities) and the suppression tier rest on the **Wilson score lower
 * bound** — the textbook small-sample estimate of a Bernoulli success rate. This replaced the old
 * path-dependent `±0.1/±0.15` rule and the interim Beta posterior mean (+ `REJECT_COST`) — see ADR-39.
 */

/**
 * Wilson score lower bound of a binomial success rate (Wilson 1927) — the principled way to RANK
 * by a rate observed from few trials: it discounts a lucky 1/1 toward 0 and tightens to the raw
 * rate as evidence accrues, so it never lets a thin sample outrank a proven one. `z=1.96` ≈ 95%.
 * Returns 0 for n≤0. (Popularized by Evan Miller, "How Not To Sort By Average Rating".)
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

/** Standard-normal critical values — the two textbook confidence levels, NOT tuned knobs. */
export const Z_95 = 1.96; // 95% — the level at which we commit to a repo-wide suppression
export const Z_68 = 1.0; //  ~68% (1σ) — the weaker level at which we merely DEMOTE

export type SuppressionTier = 'suppress' | 'demote' | 'none';

/**
 * How strongly a stream of dismissals justifies suppressing a finding — derived, not hand-tuned.
 * The only constants are the **0.5 majority pivot** (are most dispositions dismissals?) and the two
 * **textbook confidence levels** (95% / 1σ); there are no invented floors. Uses the Wilson score
 * lower bound (Wilson 1927), so it's robust to small N *by construction*: a lone 1/1 dismissal has
 * a wide interval and sits well below 0.5, so one "not now" can never bury a finding (C1). It takes
 * ~4 consistent dismissals to be 95%-confident the majority is "dismiss" (→ suppress); 1–3 only
 * `demote`; an accept/fix mixed in pulls the rate back down.
 *
 * `dismissals` = waive+reject incidents (FOR suppression); `corrections` = accept/fix (AGAINST it).
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
 * Exponential recency weight: `0.5^(ageDays / halfLifeDays)`. A non-finite half-life means "never
 * decays" (weight 1). Negative ages clamp to 0 (future-dated → full weight). Pure.
 */
export function recencyWeight(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays)) return 1;
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

/**
 * Decay the suppression evidence by recency (the keystone of the negative-knowledge loop, ADR-41):
 * each dismissal contributes `recencyWeight` instead of a flat 1, with a verb-specific half-life
 * (reject fades, waive persists). **Corrections are durable** — each contributes full weight 1: the
 * user acting on a finding is permanent evidence it was real, and must not fade and let a stale
 * suppression creep back. The decayed (fractional) counts feed straight into `suppressionTier` —
 * Wilson takes plain numbers, so as evidence ages the effective N shrinks, the interval widens, and
 * the tier slides `suppress → demote → none` (this is also the re-surface mechanism — no probe).
 */
export function decayedCounts(
  dismissals: Dismissal[],
  correctionsCount: number,
  hl: DecayHalfLives,
): { dismissals: number; corrections: number } {
  const d = dismissals.reduce((s, x) => s + recencyWeight(x.ageDays, x.verb === 'waive' ? hl.waiveDays : hl.rejectDays), 0);
  return { dismissals: d, corrections: correctionsCount };
}
