import type { Finding, Waiver } from '@plex/core';
import { normalizeTitle } from './dedupe';

/** Does a stored waiver suppress this finding, per its scope (ADR-10)? */
export function waiverMatches(f: Finding, w: Waiver): boolean {
  switch (w.scope) {
    case 'line':
      return w.file === f.location.file && w.line === f.location.startLine;
    case 'file':
      return w.file === f.location.file;
    case 'pattern-repo':
      return (
        (w.pattern != null && (w.pattern === f.pitfallId || (f.tags?.includes(w.pattern) ?? false))) ||
        (w.title != null && normalizeTitle(w.title) === normalizeTitle(f.title))
      );
    case 'category-repo':
    case 'category-global':
      return w.category != null && (f.tags?.includes(w.category) ?? false);
    default:
      return false;
  }
}

export function isWaived(f: Finding, waivers: Waiver[]): boolean {
  return waivers.some((w) => waiverMatches(f, w));
}
