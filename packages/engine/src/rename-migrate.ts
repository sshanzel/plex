import path from 'node:path';
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
 *
 * ACCEPTED TRADEOFF (diff-driven): the trigger is inherent — a rename appears in a review diff ONLY on the
 * branch/PR that performs it (after merge, `main`'s diffs no longer show it, so there is no later trigger).
 * So migration necessarily fires on an as-yet-unmerged change. If that branch is abandoned, an anchor can be
 * left pointing at a path that never landed on the base; the failure is soft and self-healing — the affected
 * finding simply re-surfaces and can be re-dismissed. A fully durable alternative (migrate when the rename
 * lands on `main`, from the git-detected rename map) is a larger follow-up; the code-graph co-change side
 * (build.ts) already migrates from git history and does not have this limitation.
 */
export async function migrateRenamedAnchors(
  repoPath: string,
  config: ReviewerConfig,
  renames: ReadonlyMap<string, string>,
): Promise<void> {
  if (renames.size === 0) return;
  try {
    const store = knowledgeStore(config);
    // The knowledge store is GLOBAL; incidents are tagged `repo = basename(resolve(repoPath))` (the same
    // id the accept/suppression path stamps in knowledge.ts). Scope the migration to THIS repo so a rename
    // here can't rewrite another repo's incident at the same relative path. (Verdicts are per-repo already.)
    const repo = path.basename(path.resolve(repoPath));
    const inc = migrateIncidentAnchors(await store.incidents(), renames, repo);
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
