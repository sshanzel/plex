/**
 * Ranking-quality evaluation (tuning.md §5): nDCG of a ranked finding list against outcome labels, so
 * a ranking change is a measured delta. Pure (no I/O): callers supply the labels.
 */

/** Graded relevance of an outcome label: confirmed defect most relevant, intentional flag mild, rejected/unlabeled irrelevant. */
export function relevanceOfOutcome(outcome: string | undefined): number {
  switch (outcome) {
    case 'accepted':
    case 'accept':
    case 'fixed':
      return 2;
    case 'acknowledged':
    case 'acknowledge':
      return 1;
    default:
      return 0; // rejected / waived / unlabeled
  }
}

/** Data-sufficiency + headroom gates for attempting the ranking re-weight (tuning.md §"deferred #1"). */
export const READINESS = {
  /** Grouped (by-round) held-out CV needs enough independent rounds to train+test without overfitting one PR. */
  minEvaluableRounds: 25,
  /** EPV floor: ≈10 positive events per fitted feature; ~5 features (severity·confidence·blast·prevalence·agreement) ⇒ 50 (Peduzzi 1996). */
  minPositives: 50,
  /** The minority outcome class must be a real fraction — without rejects there's no contrast to learn from. */
  minNegatives: 10,
  minMinorityShare: 0.2,
  /** At/above this current nDCG the default ranking already orders accepted-above-rejected — no headroom to beat. */
  headroomNdcg: 0.85,
  /** Below this share of non-zero blast, blast is ~constant in this data → it can't be a fit feature (drop it). */
  minBlastNonZeroShare: 0.1,
} as const;

/** The go/no-go on a ranking re-weight: build a fit, wait for more data, or keep the defaults. */
export type RankingVerdict = 'ready' | 'not-yet' | 'defaults-win';

/** Aggregate signals the readiness decision needs — computed from the brain's persisted samples. */
export interface ReadinessInput {
  labeledFindings: number;
  positives: number;
  negatives: number;
  evaluableRounds: number;
  meanNdcg: number | null;
  /** Fraction of labeled findings whose blast feature is non-zero (feature-variance check). */
  blastNonZeroShare: number;
}

/** Decide whether a ranking re-weight is worth building yet, and why. Gates in priority order: data sufficiency, then headroom. Pure. */
export function rankingReadiness(m: ReadinessInput): { verdict: RankingVerdict; note: string } {
  const minorityShare = m.labeledFindings ? Math.min(m.positives, m.negatives) / m.labeledFindings : 0;
  if (m.meanNdcg == null || m.evaluableRounds < READINESS.minEvaluableRounds) {
    return {
      verdict: 'not-yet',
      note: `NOT YET — ${m.evaluableRounds} evaluable round(s); need ≥${READINESS.minEvaluableRounds} across PRs for grouped held-out CV (${m.labeledFindings} labeled finding(s) so far). Keep the defaults; re-run as more review → validate → fix cycles accrue.`,
    };
  }
  if (m.positives < READINESS.minPositives) {
    return {
      verdict: 'not-yet',
      note: `NOT YET — only ${m.positives} positive (accepted/fixed) finding(s); a ~5-feature fit needs ≥${READINESS.minPositives} (≈10 per feature, the EPV rule). Keep the defaults.`,
    };
  }
  if (m.negatives < READINESS.minNegatives || minorityShare < READINESS.minMinorityShare) {
    return {
      verdict: 'not-yet',
      note: `NOT YET — labels are one-sided (${m.positives} positive / ${m.negatives} rejected-or-waived); a fit needs contrast (minority class ≥${Math.round(READINESS.minMinorityShare * 100)}% of labeled and ≥${READINESS.minNegatives}). Keep the defaults.`,
    };
  }
  if (m.meanNdcg >= READINESS.headroomNdcg) {
    return {
      verdict: 'defaults-win',
      note: `DEFAULTS ALREADY WIN — current ranking nDCG ${m.meanNdcg.toFixed(3)} ≥ ${READINESS.headroomNdcg} over ${m.evaluableRounds} round(s): the signal already orders accepted above rejected. No headroom — ship no re-weight.`,
    };
  }
  const blastHint = m.blastNonZeroShare < READINESS.minBlastNonZeroShare ? ` (Note: blast is ~constant here — ${Math.round(m.blastNonZeroShare * 100)}% non-zero — so drop it as a fit feature.)` : '';
  return {
    verdict: 'ready',
    note: `READY — ${m.evaluableRounds} rounds, ${m.positives}/${m.negatives} positive/negative labels, current nDCG ${m.meanNdcg.toFixed(3)} < ${READINESS.headroomNdcg} (headroom to improve). Build a candidate fit and ship it ONLY if it beats the defaults on grouped held-out CV by a stable, noise-clearing margin.${blastHint}`,
  };
}

/** Discounted cumulative gain of relevances in ranked order: Σ relᵢ / log₂(i + 2). Pure. */
export function dcg(relevances: number[]): number {
  return relevances.reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
}

/** Normalized DCG ∈ [0,1]: `dcg(ranked) / dcg(ideal)`. Returns 1 for an all-zero-relevance list. Pure. */
export function ndcg(rankedRelevances: number[]): number {
  const ideal = dcg([...rankedRelevances].sort((a, b) => b - a));
  return ideal > 0 ? dcg(rankedRelevances) / ideal : 1;
}

/** nDCG of a ranked finding list against an outcome-label map (findingId → outcome). Pure. */
export function rankingNdcg(
  rankedFindingIds: readonly string[],
  outcomeById: Map<string, string | undefined>,
): number {
  return ndcg(rankedFindingIds.map((id) => relevanceOfOutcome(outcomeById.get(id))));
}
