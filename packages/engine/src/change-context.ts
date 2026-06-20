import type { ReviewerConfig, ChangeContext } from '@plex/core';
import { getPrMeta, getCommitSubjects } from '@plex/ingest';
import { repoPaths } from './paths';
import type { DiffSource } from './diff';

/**
 * Resolve the change's stated motivation (PR title/body, or branch commit subjects) so the reviewer
 * can check the code against its claimed intent. Best-effort: any failure yields undefined.
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
