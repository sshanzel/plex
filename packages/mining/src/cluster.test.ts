import { describe, it, expect } from 'vitest';
import { greedyCluster, centroid } from './cluster';
import { minedPitfallId } from './distill';

// Mined-pitfall ids must be collision-free: titles differing only in punctuation, or
// emoji/CJK-only titles (which slug to ''), used to produce identical ids and silently
// overwrite each other in the knowledge base.
describe('minedPitfallId', () => {
  it('disambiguates titles that share a slug (punctuation-only difference)', () => {
    expect(minedPitfallId('Fix the bug!')).not.toBe(minedPitfallId('Fix the bug?'));
  });
  it('produces distinct, non-empty ids for emoji/CJK-only titles', () => {
    const a = minedPitfallId('🚀🚀');
    const b = minedPitfallId('💯');
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/:-?$/); // never ends in an empty slug segment
  });
  it('is stable for the same title and stamps the repo when given', () => {
    expect(minedPitfallId('Validate tenant id', 'plex')).toBe(minedPitfallId('Validate tenant id', 'plex'));
    expect(minedPitfallId('Validate tenant id', 'plex')).toContain('pf:mined:plex:');
  });
});

// Greedy embedding clustering groups review comments into pitfall candidates. Pure, only
// lightly covered before. Pin the degenerate inputs, the inclusive threshold boundary, the
// multi-member running-mean centroid, and document the threshold<=0 hazard.
describe('greedyCluster', () => {
  it('returns [] for no vectors and a single singleton cluster for one', () => {
    expect(greedyCluster([], 0.8)).toEqual([]);
    expect(greedyCluster([[1, 2, 3]], 0.8)).toEqual([[0]]);
  });

  it('merges identical vectors at threshold 1.0 (the >= boundary is inclusive)', () => {
    expect(greedyCluster([[1, 0], [1, 0]], 1.0)).toEqual([[0, 1]]);
  });

  it('keeps clearly-dissimilar vectors in separate clusters', () => {
    expect(greedyCluster([[1, 0], [0, 1]], 0.8)).toEqual([[0], [1]]);
  });

  it('groups three near-identical vectors into one cluster (running-mean centroid holds)', () => {
    const out = greedyCluster([[1, 0, 0], [0.99, 0.01, 0], [0.98, 0.02, 0]], 0.9);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(3);
  });

  it('never merges on non-positive similarity, even at threshold 0', () => {
    // Guard against the threshold<=0 footgun: orthogonal/zero vectors (cosine 0) must stay
    // in separate clusters rather than being lumped together.
    expect(greedyCluster([[1, 0], [0, 1]], 0)).toEqual([[0], [1]]);
    expect(greedyCluster([[1, 0], [0, 0]], 0)).toEqual([[0], [1]]);
  });
});

describe('centroid', () => {
  it('is the arithmetic mean of the rows', () => {
    expect(centroid([[1, 1], [3, 3], [5, 5]])).toEqual([3, 3]);
  });
  it('returns [] for no rows and tolerates ragged rows (dim fixed by row 0)', () => {
    expect(centroid([])).toEqual([]);
    expect(centroid([[2, 4], [2]])).toEqual([2, 2]); // missing dim treated as 0 → (4+0)/2
  });
});
