import path from 'node:path';

export interface RepoPaths {
  repoPath: string;
  reviewerDir: string;
  /** Kùzu code-graph DB directory for this repo. */
  graphDir: string;
  /** Append-only verdict log (feedback-loop seed). */
  verdictsFile: string;
  /** Incremental mining cursor (which PRs have been scanned). */
  miningStateFile: string;
  /** Append-only review audit log for attribution (ADR-24). */
  logFile: string;
}

/** Resolve where reviewer keeps per-repo data (default `<repo>/.reviewer`). */
export function repoPaths(repoPath: string, dataDir = '.plex'): RepoPaths {
  const abs = path.resolve(repoPath);
  const reviewerDir = path.isAbsolute(dataDir) ? dataDir : path.join(abs, dataDir);
  return {
    repoPath: abs,
    reviewerDir,
    graphDir: path.join(reviewerDir, 'graph.kuzu'),
    verdictsFile: path.join(reviewerDir, 'verdicts.jsonl'),
    miningStateFile: path.join(reviewerDir, 'mining-state.json'),
    logFile: path.join(reviewerDir, 'log', 'events.jsonl'),
  };
}
