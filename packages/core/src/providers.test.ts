import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from './providers';

// cosineSimilarity is the backbone of EVERY semantic feature — knowledge retrieval,
// mining clusters, semantic waivers (≥0.82), and round attribution. Pin its contract.
describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('is invariant to magnitude (direction only)', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([0.1, 0.2], [10, 20])).toBeCloseTo(1, 10);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 10);
  });

  it('returns 0 (not NaN) when either vector is all-zero', () => {
    // The semantic-waiver guard depends on this: a zero embedding must NOT spuriously match.
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('compares only the overlapping prefix when lengths differ (no crash, no NaN)', () => {
    // Defensive: mismatched dims (e.g. swapping embedding providers) must degrade, not throw.
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBeCloseTo(1, 10); // 3rd dim ignored
    expect(cosineSimilarity([], [1, 2, 3])).toBe(0); // empty → 0, not NaN
  });

  it('lands a partial-overlap similarity strictly between 0 and 1', () => {
    const s = cosineSimilarity([1, 1, 0], [1, 0, 0]);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
    expect(s).toBeCloseTo(1 / Math.SQRT2, 10);
  });
});
