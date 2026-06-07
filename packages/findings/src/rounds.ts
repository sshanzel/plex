import { cosineSimilarity, type ChangedRegion, type AttributedChange } from '@plex/core';

/** A region changed since last round, with its content already embedded (ADR-13/23). */
export interface RegionVec extends ChangedRegion {
  embedding: number[];
}

/** A prior finding/comment, embedded, that could *explain* a change. */
export interface SignalVec {
  embedding: number[];
  /** Human-readable reason shown when this signal explains a change. */
  label?: string;
}

export interface ClassifyOptions {
  /** Cosine similarity at/above which a change is considered explained (default 0.55). */
  threshold?: number;
}

/**
 * Classify each region changed since the previous round as **feedback-driven** (its
 * content is semantically close to a prior finding or PR comment) or **unexplained**
 * (nothing explains it — the highest-value signal to scrutinize; ADR-23).
 *
 * Embedding-based, NOT line-proximity (no heuristic — ADR-13). Pure: the I/O (head SHAs,
 * the inter-round diff, embedding) happens at the boundary; this is just the decision and
 * is unit-tested with literal vectors.
 */
export function classifyChanges(
  regions: RegionVec[],
  signals: SignalVec[],
  opts: ClassifyOptions = {},
): AttributedChange[] {
  const threshold = opts.threshold ?? 0.55;
  return regions.map((r) => {
    let best = -1;
    let bestLabel: string | undefined;
    for (const s of signals) {
      const sim = cosineSimilarity(r.embedding, s.embedding);
      if (sim > best) {
        best = sim;
        bestLabel = s.label;
      }
    }
    const region = { file: r.file, start: r.start, end: r.end };
    return best >= threshold
      ? { ...region, attribution: 'feedback-driven' as const, reason: bestLabel }
      : { ...region, attribution: 'unexplained' as const };
  });
}

/**
 * Was a prior-round finding **addressed** by one of the changes since? True when any
 * changed region's content is semantically close (cosine ≥ threshold) to the finding —
 * the autonomous "this got fixed" signal that records an `accept` without asking (ADR-28).
 * Pure: embeddings computed at the boundary, the decision unit-tested with vectors.
 */
export function findingAddressed(
  findingEmbedding: number[],
  regionEmbeddings: number[][],
  threshold = 0.6,
): boolean {
  return regionEmbeddings.some((r) => cosineSimilarity(findingEmbedding, r) >= threshold);
}
