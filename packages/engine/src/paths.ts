import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
  /** Indexed HEAD sha sidecar — staleness check without opening Kùzu (ADR-16/25). */
  headShaFile: string;
}

/** A stable, filesystem-safe id for a repo's centralized data dir (basename + path hash). */
export function repoId(repoPath: string): string {
  const abs = path.resolve(repoPath);
  const base = path.basename(abs).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) || 'repo';
  const hash = createHash('sha1').update(abs).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * Resolve where Plex keeps a repo's data. **By default it lives OUTSIDE the repo** —
 * `~/.plex/repos/<id>/` — so Plex never writes an artifact into the user's tree (no
 * `.gitignore` to add). `dataDir` overrides:
 *  - empty / unset → centralized `~/.plex/repos/<id>` (default).
 *  - absolute path → that path is the *repos root*: `<dataDir>/<id>`.
 *  - relative path (e.g. `.plex`) → in-repo, co-located: `<repo>/<dataDir>` (opt-in).
 */
export function repoPaths(repoPath: string, dataDir?: string): RepoPaths {
  const abs = path.resolve(repoPath);
  let reviewerDir: string;
  if (!dataDir) {
    reviewerDir = path.join(os.homedir(), '.plex', 'repos', repoId(abs));
  } else if (path.isAbsolute(dataDir)) {
    reviewerDir = path.join(dataDir, repoId(abs));
  } else {
    reviewerDir = path.join(abs, dataDir);
  }
  return {
    repoPath: abs,
    reviewerDir,
    graphDir: path.join(reviewerDir, 'graph.kuzu'),
    verdictsFile: path.join(reviewerDir, 'verdicts.jsonl'),
    miningStateFile: path.join(reviewerDir, 'mining-state.json'),
    logFile: path.join(reviewerDir, 'log', 'events.jsonl'),
    headShaFile: path.join(reviewerDir, 'head.sha'),
  };
}
