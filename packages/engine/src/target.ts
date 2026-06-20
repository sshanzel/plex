import path from 'node:path';
import type { DiffSource } from './diff';
import { baseRepoPath } from './paths';

/**
 * A stable id for a review target — the correlation key for the PR brain (ADR-22/23) and audit log:
 * `<repo>__pr_<n>` for a PR, else `<repo>__<mode>[_<baseRef>]`.
 */
export function reviewTarget(repo: string, src: DiffSource): string {
  const slug = (s: string): string => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  if (src.source === 'pr' && src.pr != null) return `${slug(repo)}__pr_${slug(String(src.pr))}`;
  const mode = src.mode ?? 'working';
  return `${slug(repo)}__${mode}${src.baseRef ? '_' + slug(src.baseRef) : ''}`;
}

/**
 * The CANONICAL review target for a repo path — keyed off the BASE repo basename (`baseRepoPath`),
 * never the worktree dir name or the graph's `repo` meta (ADR-46), so a worktree review and the base
 * review of the SAME PR resolve to ONE target. EVERY lineage write MUST go through this so they agree.
 */
export function reviewTargetFor(repoPath: string, src: DiffSource): string {
  return reviewTarget(path.basename(baseRepoPath(repoPath)), src);
}

/**
 * Inverse of `reviewTarget`'s suffix → the `DiffSource` to reconcile a brain target with (ADR-43).
 * `baseRef` is taken from the brain's `Round`, NOT re-parsed (the slug is lossy: `feature/x` →
 * `feature_x`). Returns `undefined` for an unrecognized suffix. Pure.
 */
export function diffSourceFromTarget(target: string, baseRef?: string): DiffSource | undefined {
  const sep = target.indexOf('__');
  if (sep < 0) return undefined;
  const suffix = target.slice(sep + 2);
  const pr = /^pr_(\d+)$/.exec(suffix);
  if (pr) return { source: 'pr', pr: Number(pr[1]) };
  if (suffix === 'working' || suffix === 'staged') return { source: 'local', mode: suffix };
  if (suffix === 'branch' || suffix.startsWith('branch_')) {
    return { source: 'local', mode: 'branch', ...(baseRef ? { baseRef } : {}) };
  }
  return undefined;
}
