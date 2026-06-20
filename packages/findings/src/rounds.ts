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
 * Classify each changed region as feedback-driven (semantically close to a prior finding/comment) or
 * unexplained (ADR-23). Embedding-based, NOT line-proximity (ADR-13). Pure — decision only.
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

/** Was a prior finding addressed? True when a changed region is semantically close (cosine ≥ threshold) to it — autonomous auto-accept (ADR-28). Pure. */
export function findingAddressed(
  findingEmbedding: number[],
  regionEmbeddings: number[][],
  threshold = 0.6,
): boolean {
  return regionEmbeddings.some((r) => cosineSimilarity(findingEmbedding, r) >= threshold);
}

/**
 * Was a prior finding addressed (ADR-28)? Either signal suffices: SEMANTIC (a changed region close to
 * the finding title — catches relocated/cross-file fixes) or LOCALITY (the finding's own file changed
 * within a windowed range — catches restructurings the cosine misses). The locality window is kept
 * TIGHT: a false accept marks a still-live bug `fixed` and it never re-surfaces. Pure.
 */
export function findingAddressedAt(
  finding: { file?: string; line?: number },
  findingEmbedding: number[],
  regions: ReadonlyArray<ChangedRegion>,
  regionEmbeddings: number[][],
  opts: { semanticThreshold?: number; lineWindow?: number } = {},
): boolean {
  return findingAddressMatch(finding, findingEmbedding, regions, regionEmbeddings, opts) != null;
}

/** Like `findingAddressedAt`, but says WHICH signal matched (`'semantic'|'locality'`) — the auto-accept audit trail. */
export function findingAddressMatch(
  finding: { file?: string; line?: number },
  findingEmbedding: number[],
  regions: ReadonlyArray<ChangedRegion>,
  regionEmbeddings: number[][],
  opts: { semanticThreshold?: number; lineWindow?: number } = {},
): 'semantic' | 'locality' | null {
  const semanticThreshold = opts.semanticThreshold ?? 0.6;
  // Drift tolerance, NOT a search radius — keep TIGHT. ±30 was far too loose (any edit in a churning
  // file lands within 30 lines, silently auto-accepting a live bug); ±5 is a DELIBERATE keep.
  const lineWindow = opts.lineWindow ?? 5;
  if (findingEmbedding.length > 0 && findingAddressed(findingEmbedding, regionEmbeddings, semanticThreshold)) {
    return 'semantic';
  }
  if (finding.file != null && finding.line != null) {
    for (const r of regions) {
      if (r.file === finding.file && finding.line >= r.start - lineWindow && finding.line <= r.end + lineWindow) {
        return 'locality';
      }
    }
  }
  return null;
}
