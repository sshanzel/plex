import { cosineSimilarity } from '@plex/core';

/**
 * Greedy single-pass clustering by embedding similarity — PURE. A comment joins the most
 * similar existing cluster above `threshold`, else starts a new one; centroids update as
 * a running mean. Good enough for the small comment sets per repo and needs no extra deps.
 * Returns clusters as arrays of original indices.
 */
export function greedyCluster(vectors: number[][], threshold: number): number[][] {
  const clusters: { indices: number[]; centroid: number[] }[] = [];

  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i]!;
    let best = -1;
    let bestSim = threshold;
    for (let c = 0; c < clusters.length; c++) {
      const sim = cosineSimilarity(v, clusters[c]!.centroid);
      // Never merge on non-positive similarity: orthogonal/anti-correlated (or zero) vectors
      // must not be lumped together even if `threshold <= 0`. No effect for any positive
      // threshold (the default is 0.6), where `sim >= threshold` already implies `sim > 0`.
      if (sim > 0 && sim >= bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best === -1) {
      clusters.push({ indices: [i], centroid: [...v] });
    } else {
      const cl = clusters[best]!;
      cl.indices.push(i);
      const n = cl.indices.length;
      for (let d = 0; d < cl.centroid.length; d++) {
        cl.centroid[d] = (cl.centroid[d]! * (n - 1) + (v[d] ?? 0)) / n;
      }
    }
  }
  return clusters.map((c) => c.indices);
}

/**
 * Adaptive cosine cut for clustering: `μ + k·σ` of the batch's OWN pairwise-cosine background
 * (tuning.md §6). A fixed cutoff (0.8) is fragile because embedding spaces are anisotropic — the
 * "unrelated" baseline cosine differs per model — so a constant means a different thing per model.
 * Estimating the cut from the batch auto-adapts: a pair is "unusually similar" only if it sits `k`
 * standard deviations above this batch's typical pair. Falls back to `fallback` when there aren't
 * enough vectors to estimate a background (n < 8), and is clamped to a sane band so a degenerate
 * batch can neither sink everything into one cluster nor shatter it into singletons. Pure.
 */
export function adaptiveCosineThreshold(
  vectors: number[][],
  opts: { fallback: number; k?: number; sampleCap?: number },
): number {
  const k = opts.k ?? 3;
  if (vectors.length < 8) return opts.fallback;
  const cap = opts.sampleCap ?? 4000;
  const sims: number[] = [];
  outer: for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      sims.push(cosineSimilarity(vectors[i]!, vectors[j]!));
      if (sims.length >= cap) break outer;
    }
  }
  const mu = sims.reduce((a, b) => a + b, 0) / sims.length;
  const variance = sims.reduce((a, b) => a + (b - mu) ** 2, 0) / sims.length;
  const sigma = Math.sqrt(variance);
  return Math.min(0.97, Math.max(0.5, mu + k * sigma));
}

export function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let d = 0; d < dim; d++) out[d] += v[d] ?? 0;
  for (let d = 0; d < dim; d++) out[d] /= vectors.length;
  return out;
}
