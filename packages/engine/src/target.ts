import type { DiffSource } from './diff';

/**
 * A stable, recognizable id for a review target — the correlation key for the PR brain
 * (ADR-22/23), the FalkorDB graph name, and the audit log: `<repo>__pr_<n>` for a PR,
 * else `<repo>__<mode>[_<baseRef>]`. Re-reviewing the same target reuses the same id.
 */
export function reviewTarget(repo: string, src: DiffSource): string {
  const slug = (s: string): string => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  if (src.source === 'pr' && src.pr != null) return `${slug(repo)}__pr_${slug(String(src.pr))}`;
  const mode = src.mode ?? 'working';
  return `${slug(repo)}__${mode}${src.baseRef ? '_' + slug(src.baseRef) : ''}`;
}
