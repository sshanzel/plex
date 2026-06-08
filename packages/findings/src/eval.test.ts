import { describe, it, expect } from 'vitest';
import { dcg, ndcg, relevanceOfOutcome, rankingNdcg } from './eval';

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
