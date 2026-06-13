import { describe, it, expect } from 'vitest';
import { greedyCluster, centroid, adaptiveCosineThreshold } from './cluster';
import { distilledPitfallId } from './distill';

describe('adaptiveCosineThreshold (per-batch cosine calibration)', () => {
  const DIM = 12;
  const e = (i: number): number[] => Array.from({ length: DIM }, (_, d) => (d === i ? 1 : 0));
  const same = (n: number): number[][] => Array.from({ length: n }, () => e(0));
  const basis = (n: number): number[][] => Array.from({ length: n }, (_, i) => e(i)); // mutually orthogonal

  it('falls back to the configured value for a small batch (n < 8)', () => {
    expect(adaptiveCosineThreshold(same(5), { fallback: 0.8 })).toBe(0.8);
    expect(adaptiveCosineThreshold([], { fallback: 0.73 })).toBe(0.73);
  });

  it('rises toward the ceiling when the batch is all near-identical (μ≈1, σ≈0)', () => {
    expect(adaptiveCosineThreshold(same(10), { fallback: 0.8 })).toBeCloseTo(0.97, 5); // clamped ceiling
  });

  it('drops to the floor when the batch is mutually orthogonal (μ≈0, σ≈0)', () => {
    expect(adaptiveCosineThreshold(basis(10), { fallback: 0.8 })).toBeCloseTo(0.5, 5); // clamped floor
  });

  it('adapts between the extremes — a batch with real spread lands in-band', () => {
    // 8 vectors: 4 share a direction (cosine 1), 4 mutually orthogonal (cosine 0) ⇒ μ,σ mid-range.
    const mixed = [...same(4), e(4), e(5), e(6), e(7)];
    const t = adaptiveCosineThreshold(mixed, { fallback: 0.8, k: 2 });
    expect(t).toBeGreaterThan(0.5);
    expect(t).toBeLessThanOrEqual(0.97);
  });
});

// Distilled-pitfall ids must be collision-free: titles differing only in punctuation, or
// emoji/CJK-only titles (which slug to ''), used to produce identical ids and silently
// overwrite each other in the knowledge base.
describe('distilledPitfallId', () => {
  it('disambiguates titles that share a slug (punctuation-only difference)', () => {
    expect(distilledPitfallId('Fix the bug!')).not.toBe(distilledPitfallId('Fix the bug?'));
  });
  it('produces distinct, non-empty ids for emoji/CJK-only titles', () => {
    const a = distilledPitfallId('🚀🚀');
    const b = distilledPitfallId('💯');
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/:-?$/); // never ends in an empty slug segment
  });
  it('is stable for the same title and stamps the repo when given', () => {
    expect(distilledPitfallId('Validate tenant id', 'plex')).toBe(distilledPitfallId('Validate tenant id', 'plex'));
    expect(distilledPitfallId('Validate tenant id', 'plex')).toContain('pf:analyzed:plex:');
  });
});

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

describe('greedyCluster — anisotropic embeddings (the threshold/centroid-sink finding)', () => {
  // Synthetic embeddings shaped like REAL ones (voyage-code-3): a shared "common" component
  // (dim 0) gives even unrelated vectors a non-trivial baseline cosine, on top of a per-group
  // direction and a tiny per-member wiggle. Tuned so within-group cosine ≈ 0.999 and
  // cross-group ≈ 0.65 — the anisotropy that makes the running-mean centroid a SINK at a low
  // threshold (the running mean drifts toward the common direction and over-attracts). Clean
  // orthogonal fixtures (the other tests here) can't surface this; this is what was missing
  // when `clusterThreshold: 0.6` collapsed 325 real comments into one cluster → 0 pitfalls.
  const NG = 3, NM = 4, C = 1.363, G = 1, e = 0.05;
  const dim = 1 + NG + NG * NM;
  const vec = (g: number, m: number): number[] => {
    const v = new Array<number>(dim).fill(0);
    v[0] = C; // shared common component (anisotropy)
    v[1 + g] = G; // per-group direction
    v[1 + NG + g * NM + m] = e; // tiny unique per-member wiggle (within-group cosine < 1)
    return v;
  };
  // Interleave groups so a cross-group vector is adjacent early — the worst case for the sink.
  const vectors: number[][] = [];
  for (let m = 0; m < NM; m++) for (let g = 0; g < NG; g++) vectors.push(vec(g, m));

  it('collapses into ONE cluster at the old 0.6 threshold (reproduces the sink)', () => {
    expect(greedyCluster(vectors, 0.6)).toHaveLength(1);
  });

  it('separates into the real groups at the 0.8 default (the fix)', () => {
    const sizes = greedyCluster(vectors, 0.8).map((c) => c.length).sort((a, b) => b - a);
    expect(sizes).toEqual([NM, NM, NM]); // 3 groups of 4 — no sink
  });

  it('the ADAPTIVE cut rescues the sink even when the configured fallback (0.6) would collapse it', () => {
    // n=12 ≥ 8, so adaptiveCosineThreshold estimates μ+kσ from THIS batch and ignores the sink-prone
    // fallback — this is the exact composition pipeline.ts runs: greedyCluster(v, adaptiveCosineThreshold(v)).
    const t = adaptiveCosineThreshold(vectors, { fallback: 0.6 });
    expect(t).toBeGreaterThan(0.8); // adapted far above the sink-prone 0.6
    const sizes = greedyCluster(vectors, t).map((c) => c.length).sort((a, b) => b - a);
    expect(sizes).toEqual([NM, NM, NM]); // 3 groups of 4 — the adaptive cut, not the fallback, drove this
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
