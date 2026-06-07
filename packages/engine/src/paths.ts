import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

export interface RepoPaths {
  repoPath: string;
  reviewerDir: string;
  /** Kùzu code-graph DB directory for this repo. */
  graphDir: string;
  /** Kùzu per-repo PR-brain DB (rounds/findings/verdicts/comments — ADR-30). */
  brainDir: string;
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
    brainDir: path.join(reviewerDir, 'brain.kuzu'),
    verdictsFile: path.join(reviewerDir, 'verdicts.jsonl'),
    miningStateFile: path.join(reviewerDir, 'mining-state.json'),
    logFile: path.join(reviewerDir, 'log', 'events.jsonl'),
    headShaFile: path.join(reviewerDir, 'head.sha'),
  };
}

/**
 * Create the reviewer data dir and make it **self-ignoring** — drop a `.gitignore` of `*`
 * inside it. The default data dir lives outside the repo (`~/.plex/repos/<id>`), but the
 * in-repo opt-in (`PLEX_DATA_DIR=.plex`) would otherwise leave a `.plex/` a user has to know
 * to gitignore. With a `*` rule inside, git treats the whole dir as ignored (the `.gitignore`
 * ignores itself too) — so an in-repo data dir is invisible to git with zero user action.
 * Idempotent and harmless for the centralized/absolute locations (they just aren't in a repo).
 */
export function ensureDataDir(reviewerDir: string): void {
  mkdirSync(reviewerDir, { recursive: true });
  const gitignore = path.join(reviewerDir, '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, '*\n', 'utf8');
}
