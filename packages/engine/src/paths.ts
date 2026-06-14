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
  /** Content-addressed embedding cache (stable, recurring texts e.g. finding titles) — so an
   * N-round PR embeds each title once, not N times. Doubles as local proof embeddings fired. */
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
 * Is `repoPath` a checkout whose `.git` is a FILE (`gitdir: …` pointer) rather than a directory?
 * That's true for a **linked git worktree** AND for a **git submodule** — both get in-workspace
 * data, which is intentional and benign for both: a submodule's `<dir>/.plex` is self-gitignored
 * and dies with the submodule checkout, exactly like a worktree. Cheap (one `stat`, no git spawn);
 * any error → false (treat as a normal repo → centralized data, the safe default).
 *
 * Assumes `repoPath` is the **checkout root** (where `.git` lives) — which the whole engine already
 * does (every git call uses `repoPath` as the cwd). A non-root subpath isn't a supported `repoPath`;
 * it would simply read as a normal repo here (no `.git` at that level) and centralize.
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
 * The **base repo** a checkout belongs to — the primary worktree the `.git` actually lives in.
 * `git rev-parse --git-common-dir` always points at the SHARED `.git` (a linked worktree's own
 * gitdir differs, but `--git-common-dir` resolves to the main one), so its parent is the base
 * checkout root — deterministic and independent of which branch `main` has checked out (unlike
 * `resolveMainRepoPath`, which picks the default-branch worktree). The lineage layer keys off this
 * so a base review and a worktree review of the same PR collect under ONE identity (ADR-46), and a
 * worktree's history outlives the worktree. Any git failure → the resolved repoPath itself (a plain
 * non-git dir is its own base).
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
 * Where the durable lineage layer lives (ADR-46): under the BASE repo's CENTRALIZED data dir
 * (`~/.plex/repos/<baseId>/lineage/`), never the worktree's `<wt>/.plex` — that's the whole point,
 * the history must survive `git worktree remove`. Per-target files (`<target>.jsonl`) limit
 * concurrent-append contention between worktrees reviewing different PRs of the same base.
 */
export function lineagePaths(repoPath: string, dataDir?: string): { lineageDir: string; fileFor: (target: string) => string } {
  // The base is a normal checkout (its `.git` is a dir), so its reviewerDir is the centralized
  // `~/.plex/repos/<id>` — even when `repoPath` is a worktree whose own data would be in-workspace.
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
    // A linked git worktree keeps its data IN the worktree (`<worktree>/.plex`, self-gitignored by
    // `ensureDataDir`) rather than centralized — so its graph (a copy of the base's, ADR-32/ADR-39:
    // never a read-only share, Kùzu's read-only open SIGSEGVs on Linux) and brain DIE WITH the
    // worktree folder. No centralized orphan to garbage-collect. Falls back to centralized on any
    // detection ambiguity. An explicit `dataDir` override still wins.
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
