import type { ReviewerConfig } from '@plex/core';
import { rankingNdcg, relevanceOfOutcome } from '@plex/findings';
import { Brain } from './brain';

export interface RankingQuality {
  /** Findings carrying any recorded outcome (live verdict or inferred fix). */
  labeledFindings: number;
  /** Review rounds with ≥2 findings AND ≥1 positively-outcomed finding — the only ones nDCG can score. */
  evaluableRounds: number;
  /** Mean nDCG of the current `signal` ranking against outcomes over the evaluable rounds (null if none). */
  meanNdcg: number | null;
  /** Human-readable verdict — including the "not enough data yet" case. */
  note: string;
}

/**
 * Offline ranking-quality measurement (tuning.md §5) — **measurement only, no weights change.**
 *
 * Reads the per-repo brain (each finding's `signal` + its resolved outcome — data the review flow
 * already persists, mining-INDEPENDENT) and asks: how well does the current `signal` ranking match
 * what the user actually accepted? Per review round it ranks findings by signal and scores that
 * order with nDCG against the outcomes; reports the mean over evaluable rounds.
 *
 * This is the guard before any re-weight: it tells us whether THIS user's accrued data is rich
 * enough to beat the defaults — if it isn't, we keep them. It never mutates the ranking.
 */
export async function rankingQuality(repoPath: string, config: ReviewerConfig): Promise<RankingQuality> {
  const brain = await Brain.open(repoPath, config);
  try {
    const samples = await brain.rankingSamples();
    const labeledFindings = samples.filter((s) => s.outcome).length;

    const groups = new Map<string, typeof samples>();
    for (const s of samples) {
      const key = `${s.target}#${s.round}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
    }

    const ndcgs: number[] = [];
    for (const g of groups.values()) {
      const positives = g.filter((s) => relevanceOfOutcome(s.outcome) > 0).length;
      if (g.length < 2 || positives === 0) continue; // need something to rank AND a relevant item
      const ranked = [...g].sort((a, b) => b.signal - a.signal).map((s) => s.id);
      ndcgs.push(rankingNdcg(ranked, new Map(g.map((s) => [s.id, s.outcome]))));
    }
    const meanNdcg = ndcgs.length ? ndcgs.reduce((a, b) => a + b, 0) / ndcgs.length : null;
    const note =
      meanNdcg == null
        ? 'Not enough labeled data yet — no round has both ≥2 findings and a recorded positive outcome. Keep the default weights; re-run after more review → validate → fix cycles accrue.'
        : `Mean nDCG ${meanNdcg.toFixed(3)} over ${ndcgs.length} evaluable round(s) (1.0 = the signal ranking already matches outcomes). A re-weight is only worth shipping if it beats this on held-out data.`;
    return { labeledFindings, evaluableRounds: ndcgs.length, meanNdcg, note };
  } finally {
    await brain.close();
  }
}
