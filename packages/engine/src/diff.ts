import type { ReviewerConfig, NormalizedDiff } from '@plex/core';
import { getLocalDiff, getPrDiff, type LocalDiffMode } from '@plex/ingest';
import { repoPaths } from './paths';

export interface DiffSource {
  source?: 'local' | 'pr';
  mode?: LocalDiffMode;
  baseRef?: string;
  pr?: string | number;
}

/** Resolve any supported input to a normalized diff (ADR-14). */
export function resolveDiff(
  repoPath: string,
  config: ReviewerConfig,
  src: DiffSource,
): Promise<NormalizedDiff> {
  const cwd = repoPaths(repoPath, config.dataDir).repoPath;
  if (src.source === 'pr' && src.pr != null) return getPrDiff({ pr: src.pr, cwd });
  return getLocalDiff({ mode: src.mode, baseRef: src.baseRef, cwd });
}
