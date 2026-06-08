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

/**
 * Was a prior finding **addressed** by the changes since it was raised — combining two
 * signals so a restructuring fix still counts (ADR-28, refined):
 *
 *   1. **Semantic** — a changed region's content is close (cosine ≥ `semanticThreshold`) to the
 *      finding title. Catches a fix in a DIFFERENT place than the original anchor (code moved
 *      or extracted), and cross-file fixes.
 *   2. **Locality** — the finding's *own file* changed and its line falls within a windowed
 *      changed range. This is the signal pure-embedding matching MISSES: a fix that wraps the
 *      flagged loop in try/catch, or moves the flagged entity lines, stays in the same file/area
 *      but reads nothing like the bug's *title* — so the cosine never clears the bar even though
 *      the code clearly got touched. Anchoring on the finding's location recovers those.
 *
 * Either signal suffices, but the locality window is kept TIGHT (see `lineWindow`): a false accept
 * doesn't merely over-reinforce a pitfall — it marks a still-live bug `fixed`, drops it from the
 * stream, and never re-surfaces it. So locality must mean "the fix touched THIS code," not "someone
 * edited nearby." Genuinely relocated/restructured fixes are caught by the semantic signal instead.
 * Pure — embeddings/diff computed at the boundary, the decision unit-tested with vectors.
 */
export function findingAddressedAt(
  finding: { file?: string; line?: number },
  findingEmbedding: number[],
  regions: ReadonlyArray<ChangedRegion>,
  regionEmbeddings: number[][],
  opts: { semanticThreshold?: number; lineWindow?: number } = {},
): boolean {
  const semanticThreshold = opts.semanticThreshold ?? 0.6;
  // Drift tolerance, NOT a search radius — the changed region already spans the fix; this only
  // absorbs the few lines a finding's RECORDED line may have shifted (edits above it). ±30 was far
  // too loose: in a churning file almost any later edit lands within 30 lines of a prior finding,
  // silently auto-accepting (and burying) a live bug. Tight keeps locality honest; semantic carries
  // relocated fixes.
  const lineWindow = opts.lineWindow ?? 5;
  if (findingEmbedding.length > 0 && findingAddressed(findingEmbedding, regionEmbeddings, semanticThreshold)) {
    return true;
  }
  if (finding.file != null && finding.line != null) {
    for (const r of regions) {
      if (r.file === finding.file && finding.line >= r.start - lineWindow && finding.line <= r.end + lineWindow) {
        return true;
      }
    }
  }
  return false;
}
