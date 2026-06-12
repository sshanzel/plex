/**
 * Statistical primitives for outcome-driven knowledge confidence (see docs/design/tuning.md §1).
 *
 * Replaces the old path-dependent `confidence += 0.1·accept − 0.15·reject` rule — which clamped
 * (destroying information: a pitfall pinned at 1.0 from 3 accepts looked identical to one from 30)
 * and let one early reject bury a good pitfall forever — with the textbook Beta-Bernoulli estimate
 * of a success rate plus the Wilson lower bound for small-sample ranking.
 */

/** Posterior mean of a Beta(α, β) — the point estimate of a Bernoulli success rate. Pure. */
export function betaPosteriorMean(alpha: number, beta: number): number {
  const d = alpha + beta;
  return d > 0 ? alpha / d : 0;
}

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
