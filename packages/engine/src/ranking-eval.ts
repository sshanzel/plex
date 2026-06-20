import type { ReviewerConfig } from '@plex/core';
import { rankingNdcg, relevanceOfOutcome, rankingReadiness, type RankingVerdict } from '@plex/findings';
import { Brain } from './brain';

export interface RankingQuality {
  /** Findings carrying any recorded outcome (live verdict or inferred fix). */
  labeledFindings: number;
  /** Labeled findings the user valued (accepted/fixed = 2, acknowledged = 1). */
  positives: number;
  /** Labeled findings the user did NOT value (rejected/waived). */
  negatives: number;
  /** Review rounds with ≥2 findings AND ≥1 positively-outcomed finding — the only ones nDCG can score. */
  evaluableRounds: number;
  /** Mean nDCG of the current `signal` ranking against outcomes over the evaluable rounds (null if none). */
  meanNdcg: number | null;
  /** The readiness verdict for deferred #1 — what the user should actually DO. */
  verdict: RankingVerdict;
  /** Human-readable verdict line naming the binding gate (`READY` / `NOT YET` / `DEFAULTS ALREADY WIN`). */
  note: string;
}

/**
 * Offline ranking-quality measurement + re-weight readiness gate (tuning.md §5) — MEASUREMENT ONLY,
 * never mutates the ranking. Reads the brain's persisted `signal` + features + outcomes and returns
 * per-round nDCG plus a go/no-go `verdict` (`not-yet` / `defaults-win` / `ready`).
 */
export async function rankingQuality(repoPath: string, config: ReviewerConfig): Promise<RankingQuality> {
  const brain = await Brain.open(repoPath, config);
  try {
    const samples = await brain.rankingSamples();
    const labeled = samples.filter((s) => s.outcome);
    const labeledFindings = labeled.length;
    const positives = labeled.filter((s) => relevanceOfOutcome(s.outcome) > 0).length;
    const negatives = labeledFindings - positives;

    const groups = new Map<string, typeof samples>();
    for (const s of samples) {
      const key = `${s.target}#${s.round}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
    }

    const ndcgs: number[] = [];
    for (const g of groups.values()) {
      const positiveInRound = g.filter((s) => relevanceOfOutcome(s.outcome) > 0).length;
      if (g.length < 2 || positiveInRound === 0) continue; // need something to rank AND a relevant item
      const ranked = [...g].sort((a, b) => b.signal - a.signal).map((s) => s.id);
      ndcgs.push(rankingNdcg(ranked, new Map(g.map((s) => [s.id, s.outcome]))));
    }
    const evaluableRounds = ndcgs.length;
    const meanNdcg = evaluableRounds ? ndcgs.reduce((a, b) => a + b, 0) / evaluableRounds : null;
    const blastNonZeroShare = labeledFindings ? labeled.filter((s) => s.blast > 0).length / labeledFindings : 0;

    const { verdict, note } = rankingReadiness({ labeledFindings, positives, negatives, evaluableRounds, meanNdcg, blastNonZeroShare });
    return { labeledFindings, positives, negatives, evaluableRounds, meanNdcg, verdict, note };
  } finally {
    await brain.close();
  }
}
