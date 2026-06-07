import path from 'node:path';
import type { DiffSource } from './diff';

/**
 * A stable, recognizable id for a review target — the correlation key for the PR brain
 * (ADR-22/23) and the audit log: `<repo>__pr_<n>` for a PR, else `<repo>__<mode>[_<baseRef>]`.
 * Re-reviewing the same target reuses the same id.
 */
export function reviewTarget(repo: string, src: DiffSource): string {
  const slug = (s: string): string => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  if (src.source === 'pr' && src.pr != null) return `${slug(repo)}__pr_${slug(String(src.pr))}`;
  const mode = src.mode ?? 'working';
  return `${slug(repo)}__${mode}${src.baseRef ? '_' + slug(src.baseRef) : ''}`;
}

/**
 * The CANONICAL review target for a repo *path* — always the resolved directory **basename**,
 * never the code graph's `repo` meta. Every brain path (round recording, finding writes,
 * verdicts, reconcile, record_outcome) MUST go through this so they agree on the key.
 *
 * Why basename and not the graph meta: a secondary git worktree seeds its graph by COPYING the
 * base repo's graph (ADR-32), so the copy carries the BASE's `repo` meta (e.g. `playright`) while
 * the worktree directory is named differently (e.g. `dazzling-spinning-harbor`). Keying rounds
 * off the graph meta but findings off the basename then splits the brain in two — rounds under
 * one target, findings under another — so reconcile finds findings but no `lastHeadSha` and bails
 * (`checked: N, accepted: 0`). Basename is also free (no Kùzu open), which reconcile needs.
 */
export function reviewTargetFor(repoPath: string, src: DiffSource): string {
  return reviewTarget(path.basename(path.resolve(repoPath)), src);
}
