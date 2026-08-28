import type { NormalizedDiff, ReviewerConfig } from '@plex/core';
import { migrateIncidentAnchors } from '@plex/knowledge';
import { knowledgeStore } from './knowledge';
import { readVerdicts, replaceVerdicts, migrateWaiverAnchors } from './verdicts';

/**
 * old→new repo-relative POSIX paths for the file renames in this review's diff (ADR-53). A diff is a
 * single old→new snapshot, so there are no in-diff rename chains to resolve (git renders A→C as one rename).
 */
export function renameMapFromDiff(diff: NormalizedDiff): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of diff.files) {
    if (f.status === 'renamed' && f.oldPath && f.oldPath !== f.path) m.set(f.oldPath, f.path);
  }
  return m;
}

/**
 * Re-anchor path-keyed knowledge anchors — code-path-memory Incidents AND symbol-scoped Waivers — across
 * the renames in this review's diff (ADR-53), so a rename doesn't silence a regression sentinel or
 * un-suppress a waived finding. Best-effort and a no-op when the diff renames nothing; the prefix rewrite
 * is idempotent, so a re-review of the same rename finds no old path left to change. Runs BEFORE the review
 * reads the stores (`loadWaivers`, `matchCodePath`), so the same review already sees the migrated anchors.
 */
export async function migrateRenamedAnchors(
  repoPath: string,
  config: ReviewerConfig,
  renames: ReadonlyMap<string, string>,
): Promise<void> {
  if (renames.size === 0) return;
  try {
    const store = knowledgeStore(config);
    const inc = migrateIncidentAnchors(await store.incidents(), renames);
    if (inc.changed) await store.replaceIncidents(inc.incidents);
  } catch {
    /* best-effort: a knowledge-store hiccup must never fail the review */
  }
  try {
    const mig = migrateWaiverAnchors(await readVerdicts(repoPath, config), renames);
    if (mig.changed) await replaceVerdicts(repoPath, config, mig.verdicts);
  } catch {
    /* best-effort */
  }
}
