/**
 * Ranking-quality evaluation (tuning.md §5).
 *
 * The ranking WEIGHTS in `signal.ts` (severity × confidence × blast × deviation × agreement) can't
 * be derived from a formula — they encode a preference and need LABELED relevance to fit/validate.
 * We already produce those labels two ways:
 *   - live `record_outcome` verdicts (accept/reject/acknowledge), and
 *   - at scale, MINED PR history — every substantive review comment is a finding a human cared
 *     about, and its outcome grades it (the mining pipeline already pulls comment → outcome).
 *
 * This module is the measuring stick: nDCG (Järvelin & Kekäläinen 2002) of a ranked finding list
 * against those labels — so a ranking change becomes a measured delta instead of a guess, and later
 * the objective an offline weight-fit maximizes. Pure (no I/O): callers supply the labels.
 */

/**
 * Graded relevance of an outcome label: a confirmed defect is most relevant, an intentional flag
 * mild, a rejected/never-actioned finding irrelevant. Mirrors the `record_outcome` verdict kinds
 * and the mined-incident outcomes (`accepted`/`fixed`/`rejected`).
 */
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

/** Discounted cumulative gain of relevances in ranked order: Σ relᵢ / log₂(i + 2). Pure. */
export function dcg(relevances: number[]): number {
  return relevances.reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
}

/**
 * Normalized DCG ∈ [0,1]: `dcg(ranked) / dcg(ideal)`. 1 = the ranking already matches the ideal
 * (most-relevant-first) order. Returns 1 for an all-zero-relevance list (nothing to order). Pure.
 */
export function ndcg(rankedRelevances: number[]): number {
  const ideal = dcg([...rankedRelevances].sort((a, b) => b - a));
  return ideal > 0 ? dcg(rankedRelevances) / ideal : 1;
}

/**
 * nDCG of a finding list (in the order Plex ranked it) against an outcome-label map
 * (findingId → outcome). The bridge from labels — live verdicts OR mined incidents — to one
 * ranking-quality number. Pure.
 */
export function rankingNdcg(
  rankedFindingIds: readonly string[],
  outcomeById: Map<string, string | undefined>,
): number {
  return ndcg(rankedFindingIds.map((id) => relevanceOfOutcome(outcomeById.get(id))));
}
