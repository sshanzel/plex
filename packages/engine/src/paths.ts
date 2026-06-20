import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export interface RepoPaths {
  repoPath: string;
  reviewerDir: string;
  /** Kùzu code-graph DB directory for this repo. */
  graphDir: string;
  /** Append-only verdict log (feedback-loop seed). */
  verdictsFile: string;
  /** Incremental review-history analysis cursor (which PRs have been scanned). */
  analyzeStateFile: string;
  /** Append-only review audit log for attribution (ADR-24). */
  logFile: string;
  /** Indexed HEAD sha sidecar — staleness check without opening Kùzu (ADR-16/25). */
  headShaFile: string;
  /** Plain-text file recording the absolute repoPath — lets `doctor` detect orphaned data dirs. */
  repoPathFile: string;
  /** Content-addressed embedding cache (stable, recurring texts e.g. finding titles). */
  embedCacheFile: string;
  /** Background maintenance worker (ADR-43) per-target reconcile cursor + per-job last-run. */
  sweepStateFile: string;
  /** Worker debounce marker — its mtime is the last sweep attempt (≤1 run / interval / data dir). */
  sweepMarkerFile: string;
  /** Worker single-flight lock — `openSync(..,'wx')` so only one sweep runs per data dir. */
  sweepLockFile: string;
  /** The base (`main`) HEAD sha a worktree's graph was SEEDED from (ADR-32/43) — staleness vs main. */
  baseShaFile: string;
}

/**
 * Is `repoPath` a checkout whose `.git` is a FILE (gitdir pointer) rather than a directory? True for a
 * linked worktree or submodule — both get in-workspace data (self-gitignored, dies with the checkout).
 * Cheap (one `stat`); any error → false (treat as a normal repo → centralized data, the safe default).
 */
function isLinkedWorktree(repoPath: string): boolean {
  try {
    const g = path.join(repoPath, '.git');
    return existsSync(g) && statSync(g).isFile();
  } catch {
    return false;
  }
}

/**
 * The base repo a checkout belongs to — the primary worktree the shared `.git` lives in
 * (`--git-common-dir`'s parent). The lineage layer keys off this so a base and a worktree review of the
 * same PR collect under ONE identity (ADR-46). Any git failure → the resolved repoPath (its own base).
 */
export function baseRepoPath(repoPath: string): string {
  const abs = path.resolve(repoPath);
  try {
    const r = spawnSync('git', ['-C', abs, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
    const commonDir = r.status === 0 ? r.stdout.trim() : '';
    if (commonDir) return path.dirname(path.resolve(commonDir)); // <base>/.git → <base>
  } catch {
    /* not a git repo / git unavailable — fall through */
  }
  return abs;
}

/** Stable id for the BASE repo — the lineage store's key (ADR-46). */
export function baseRepoId(repoPath: string): string {
  return repoId(baseRepoPath(repoPath));
}

/**
 * Where the durable lineage layer lives (ADR-46): under the BASE repo's CENTRALIZED data dir, never the
 * worktree's `<wt>/.plex` — the history must survive `git worktree remove`. Per-target files limit
 * concurrent-append contention between worktrees reviewing different PRs of the same base.
 */
export function lineagePaths(repoPath: string, dataDir?: string): { lineageDir: string; fileFor: (target: string) => string } {
  const base = baseRepoPath(repoPath);
  const lineageDir = path.join(repoPaths(base, dataDir).reviewerDir, 'lineage');
  const safe = (t: string): string => t.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'target';
  return { lineageDir, fileFor: (target) => path.join(lineageDir, `${safe(target)}.jsonl`) };
}

/** A stable, filesystem-safe id for a repo's centralized data dir (basename + path hash). */
export function repoId(repoPath: string): string {
  const abs = path.resolve(repoPath);
  const base = path.basename(abs).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) || 'repo';
  const hash = createHash('sha1').update(abs).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * Resolve where Plex keeps a repo's data. By default OUTSIDE the repo (`~/.plex/repos/<id>/`).
 * `dataDir`: empty → centralized; absolute → `<dataDir>/<id>` (repos root); relative → in-repo `<repo>/<dataDir>`.
 */
export function repoPaths(repoPath: string, dataDir?: string): RepoPaths {
  const abs = path.resolve(repoPath);
  let reviewerDir: string;
  if (!dataDir) {
    // A linked worktree keeps its data IN the worktree (`<worktree>/.plex`, self-gitignored) — its graph
    // is a COPY of the base's, NEVER a read-only share (Kùzu's read-only open SIGSEGVs on Linux,
    // ADR-32/ADR-39). Falls back to centralized on any detection ambiguity.
    reviewerDir = isLinkedWorktree(abs)
      ? path.join(abs, '.plex')
      : path.join(os.homedir(), '.plex', 'repos', repoId(abs));
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
    analyzeStateFile: path.join(reviewerDir, 'analyze-state.json'),
    logFile: path.join(reviewerDir, 'log', 'events.jsonl'),
    headShaFile: path.join(reviewerDir, 'head.sha'),
    repoPathFile: path.join(reviewerDir, 'repo-path'),
    embedCacheFile: path.join(reviewerDir, 'embed-cache.json'),
    sweepStateFile: path.join(reviewerDir, 'sweep-state.json'),
    sweepMarkerFile: path.join(reviewerDir, 'sweep-last.txt'),
    sweepLockFile: path.join(reviewerDir, 'sweep.lock'),
    baseShaFile: path.join(reviewerDir, 'base.sha'),
  };
}

/**
 * Create the reviewer data dir and make it self-ignoring (drop a `.gitignore` of `*` inside) so an
 * in-repo opt-in data dir is invisible to git with zero user action. Idempotent.
 */
export function ensureDataDir(reviewerDir: string): void {
  mkdirSync(reviewerDir, { recursive: true });
  const gitignore = path.join(reviewerDir, '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, '*\n', 'utf8');
}
