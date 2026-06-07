import { describe, it, expect } from 'vitest';
import { greedyCluster, centroid } from './cluster';

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

  it('DOCUMENTS the threshold<=0 hazard: orthogonal/zero vectors merge (cosine 0 >= 0)', () => {
    // cosineSimilarity returns 0 for orthogonal/zero vectors, so a non-positive threshold
    // lumps unrelated comments together. Default config uses 0.4, so production is safe;
    // this pins the current behavior as a known sharp edge, not a recommendation.
    expect(greedyCluster([[1, 0], [0, 1]], 0)).toEqual([[0, 1]]);
    expect(greedyCluster([[1, 0], [0, 0]], 0)).toEqual([[0, 1]]);
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
