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
