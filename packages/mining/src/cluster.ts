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

/** Mean vector of the given rows. */
export function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let d = 0; d < dim; d++) out[d] += v[d] ?? 0;
  for (let d = 0; d < dim; d++) out[d] /= vectors.length;
  return out;
}
