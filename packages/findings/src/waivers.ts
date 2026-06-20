import type { Finding, Waiver } from '@plex/core';
import { cosineSimilarity, symbolKey } from '@plex/core';
import { normalizeTitle } from './dedupe';

/**
 * Does a stored waiver suppress this finding, per its scope (ADR-10)? Pattern/category scopes also
 * match SEMANTICALLY (ADR-27) when both carry an embedding and cosine ≥ `semanticThreshold`. The
 * default 1.01 disables semantic matching (pure identity behavior when no embeddings supplied).
 */
export function waiverMatches(f: Finding, w: Waiver, semanticThreshold = 1.01): boolean {
  const semantic =
    w.embedding != null &&
    f.embedding != null &&
    cosineSimilarity(w.embedding, f.embedding) >= semanticThreshold;
  // Symbol gate (ADR-48): a file/line waiver carrying a `symbol` suppresses only a finding at the SAME
  // `file#name` (else the rule still surfaces elsewhere); a symbol-less waiver keeps file/line matching.
  const symbolOk =
    w.symbol == null ||
    (f.location.symbol != null && symbolKey(f.location.file, f.location.symbol) === w.symbol);
  switch (w.scope) {
    case 'line':
      return w.file === f.location.file && w.line === f.location.startLine && symbolOk;
    case 'file':
      return w.file === f.location.file && symbolOk;
    case 'pattern-repo':
      return (
        semantic ||
        (w.pattern != null && (w.pattern === f.pitfallId || (f.tags?.includes(w.pattern) ?? false))) ||
        (w.title != null && normalizeTitle(w.title) === normalizeTitle(f.title))
      );
    case 'category-repo':
    case 'category-global':
      return semantic || (w.category != null && (f.tags?.includes(w.category) ?? false));
    default:
      return false;
  }
}

export function isWaived(f: Finding, waivers: Waiver[], semanticThreshold?: number): boolean {
  return waivers.some((w) => waiverMatches(f, w, semanticThreshold));
}

/**
 * Audit helper (ADR-41): the embedding-keyed suppression decisions that actually FIRED — matched a
 * finding through the same `pattern-repo` semantic test the ranking used (so the audit can't drift). Pure.
 */
export function firedSemanticSuppressions<T extends { embedding?: number[] }>(
  decisions: T[],
  findings: Finding[],
  semanticThreshold: number,
): T[] {
  return decisions.filter(
    (d) => d.embedding != null && findings.some((f) => waiverMatches(f, { scope: 'pattern-repo', embedding: d.embedding }, semanticThreshold)),
  );
}
