import type { ReviewerConfig, ChangeContext } from '@plex/core';
import { getPrMeta, getCommitSubjects } from '@plex/ingest';
import { repoPaths } from './paths';
import type { DiffSource } from './diff';

/**
 * Resolve the *stated motivation* behind a change so the reviewer can check the code
 * AGAINST its claimed intent (flag overclaims, behavior that contradicts the description).
 *
 * - PR review  → PR title/body/url (`gh pr view`).
 * - branch review → commit subjects in `base..HEAD` (the change's narrative).
 * - working/staged → nothing stated yet; returns undefined (no motivation to check against).
 *
 * Best-effort: any failure (no `gh`, detached repo, no commits) yields undefined.
 */
export async function resolveChangeContext(
  repoPath: string,
  config: ReviewerConfig,
  src: DiffSource,
): Promise<ChangeContext | undefined> {
  const cwd = repoPaths(repoPath, config.dataDir).repoPath;

  if (src.source === 'pr' && src.pr != null) {
    const meta = await getPrMeta({ pr: src.pr, cwd });
    if (!meta.title && !meta.body && !meta.url) return undefined;
    return { title: meta.title, description: meta.body, url: meta.url };
  }

  if (src.mode === 'branch') {
    const commits = await getCommitSubjects(cwd, src.baseRef ?? 'main');
    if (commits.length === 0) return undefined;
    return { commits };
  }

  return undefined;
}
