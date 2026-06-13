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

/**
 * Inverse of `reviewTarget`'s suffix → the `DiffSource` to reconcile a brain target with (ADR-43,
 * the maintenance worker). The repo prefix is dropped — the sweep already knows `repoPath`; only the
 * `__`-suffix carries source/mode/pr. `baseRef` is taken from the brain's `Round` (NOT re-parsed: the
 * `reviewTarget` slug is lossy — `feature/x` → `feature_x`). Returns `undefined` for an unrecognized
 * suffix (the sweep skips it). Pure — unit-tested with literal targets.
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
