import type { Finding, Waiver } from '@plex/core';
import { cosineSimilarity } from '@plex/core';
import { normalizeTitle } from './dedupe';

/**
 * Does a stored waiver suppress this finding, per its scope (ADR-10)?
 *
 * For the "this KIND of issue" scopes (pattern/category), a waiver also matches
 * **semantically** (ADR-27): if both carry an embedding and their cosine ≥
 * `semanticThreshold`, the same issue is suppressed even after its wording changed or its
 * lines moved. The default threshold (1.01) disables semantic matching, preserving the
 * pure identity behavior when embeddings aren't supplied.
 */
export function waiverMatches(f: Finding, w: Waiver, semanticThreshold = 1.01): boolean {
  const semantic =
    w.embedding != null &&
    f.embedding != null &&
    cosineSimilarity(w.embedding, f.embedding) >= semanticThreshold;
  switch (w.scope) {
    case 'line':
      return w.file === f.location.file && w.line === f.location.startLine;
    case 'file':
      return w.file === f.location.file;
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
