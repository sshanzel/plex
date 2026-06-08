import { describe, it, expect } from 'vitest';
import { dcg, ndcg, relevanceOfOutcome, rankingNdcg, rankingReadiness, READINESS, type ReadinessInput } from './eval';

describe('relevanceOfOutcome', () => {
  it('grades confirmed > acknowledged > rejected/unlabeled', () => {
    expect(relevanceOfOutcome('accepted')).toBe(2);
    expect(relevanceOfOutcome('fixed')).toBe(2);
    expect(relevanceOfOutcome('acknowledge')).toBe(1);
    expect(relevanceOfOutcome('rejected')).toBe(0);
    expect(relevanceOfOutcome(undefined)).toBe(0);
  });
});

describe('dcg / ndcg', () => {
  it('dcg discounts later positions by log2', () => {
    expect(dcg([3, 2, 1])).toBeCloseTo(3 + 2 / Math.log2(3) + 1 / Math.log2(4), 6);
  });
  it('ndcg is 1 when the ranking is already ideal', () => {
    expect(ndcg([2, 1, 0])).toBe(1);
  });
  it('ndcg is < 1 when relevant items are ranked late', () => {
    expect(ndcg([0, 1, 2])).toBeLessThan(1);
    expect(ndcg([0, 2, 1])).toBeLessThan(ndcg([2, 1, 0]));
  });
  it('ndcg is 1 for an all-irrelevant list (nothing to order)', () => {
    expect(ndcg([0, 0, 0])).toBe(1);
  });
});

describe('rankingNdcg (the label bridge)', () => {
  const labels = new Map<string, string | undefined>([
    ['a', 'accepted'],
    ['b', 'rejected'],
    ['c', 'acknowledge'],
  ]);
  it('a ranking that puts the accepted finding first scores higher than the reverse', () => {
    const good = rankingNdcg(['a', 'c', 'b'], labels); // accepted, ack, rejected
    const bad = rankingNdcg(['b', 'c', 'a'], labels); // rejected first, accepted last
    expect(good).toBe(1);
    expect(bad).toBeLessThan(good);
  });
});

describe('rankingReadiness (the re-weight go/no-go)', () => {
  // A baseline that clears every gate; each test perturbs one dimension.
  const ready: ReadinessInput = {
    labeledFindings: 120,
    positives: 70,
    negatives: 50,
    evaluableRounds: 30,
    meanNdcg: 0.7, // below headroom ⇒ room to improve
    blastNonZeroShare: 0.6,
  };

  it('NOT YET when there is no score / too few evaluable rounds (CV floor)', () => {
    expect(rankingReadiness({ ...ready, meanNdcg: null, evaluableRounds: 0 }).verdict).toBe('not-yet');
    const r = rankingReadiness({ ...ready, evaluableRounds: READINESS.minEvaluableRounds - 1 });
    expect(r.verdict).toBe('not-yet');
    expect(r.note).toMatch(/NOT YET/);
    expect(r.note).toMatch(/round/);
  });

  it('NOT YET when too few positive labels (EPV floor) even with enough rounds', () => {
    const r = rankingReadiness({ ...ready, positives: READINESS.minPositives - 1, negatives: 80 });
    expect(r.verdict).toBe('not-yet');
    expect(r.note).toMatch(/positive/);
  });

  it('NOT YET when labels are one-sided (no contrast to learn from)', () => {
    // Plenty of positives + rounds, but the minority (negatives) is too small a share.
    const r = rankingReadiness({ labeledFindings: 1000, positives: 990, negatives: 10, evaluableRounds: 40, meanNdcg: 0.6, blastNonZeroShare: 0.5 });
    expect(r.verdict).toBe('not-yet');
    expect(r.note).toMatch(/one-sided/);
  });

  it('DEFAULTS ALREADY WIN when the current ranking already matches outcomes (no headroom)', () => {
    const r = rankingReadiness({ ...ready, meanNdcg: READINESS.headroomNdcg });
    expect(r.verdict).toBe('defaults-win');
    expect(r.note).toMatch(/DEFAULTS ALREADY WIN/);
  });

  it('READY when there is enough balanced data AND headroom to beat', () => {
    const r = rankingReadiness(ready);
    expect(r.verdict).toBe('ready');
    expect(r.note).toMatch(/READY/);
    expect(r.note).toMatch(/held-out CV/); // must still validate before shipping
    expect(r.note).not.toMatch(/blast is ~constant/); // blast varies here
  });

  it('READY still flags a constant blast feature so the fit drops it', () => {
    const r = rankingReadiness({ ...ready, blastNonZeroShare: 0.02 });
    expect(r.verdict).toBe('ready');
    expect(r.note).toMatch(/blast is ~constant/);
  });

  it('gates are checked in priority order — rounds before labels', () => {
    // Fails BOTH the round gate and the positives gate; the round gate (checked first) wins the message.
    const r = rankingReadiness({ ...ready, evaluableRounds: 1, positives: 1 });
    expect(r.verdict).toBe('not-yet');
    expect(r.note).toMatch(/round/);
    expect(r.note).not.toMatch(/EPV/);
  });
});
