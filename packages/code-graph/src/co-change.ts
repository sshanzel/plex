import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isGeneratedArtifact, retryTransientSpawn } from '@plex/core';
import { isSupportedSource } from './languages';

const pexec = promisify(execFile);
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

const isIndexable = (p: string): boolean =>
  isSupportedSource(p) && !p.endsWith('.d.ts') && !isGeneratedArtifact(p);

export interface CommitRecord {
  /** Author/commit time in seconds since epoch. */
  tsSec: number;
  /** Repo-relative paths touched by the commit. */
  files: string[];
}

export interface CoChangePair {
  /** Lexically smaller path. */
  a: string;
  /** Lexically larger path. */
  b: string;
  weight: number;
  count: number;
}

export interface AggregateOptions {
  /** Commits touching more files than this contribute ~0 (lint/format sweeps). */
  maxCommitFiles: number;
  halfLifeDays: number;
  /** Drop pairs co-occurring fewer than this many times. */
  minPairCount: number;
  /** "now" in seconds, for recency decay (defaults to current time). */
  nowSec?: number;
}

/**
 * Aggregate commits into weighted co-change pairs — PURE (ADR-06). Contribution per pair from a commit
 * = recencyDecay × sizeFactor, where recencyDecay = 0.5^(ageDays/halfLifeDays) and sizeFactor = 1/(n-1)
 * (a 2-file commit is strong evidence, a 25-file one is noise). Commits with n < 2 or > maxCommitFiles are skipped.
 */
export function aggregateCoChange(commits: CommitRecord[], opts: AggregateOptions): CoChangePair[] {
  const nowSec = opts.nowSec ?? Date.now() / 1000;
  const halfLifeSec = opts.halfLifeDays * 86400;
  const acc = new Map<string, { a: string; b: string; weight: number; count: number }>();

  for (const commit of commits) {
    // Generated artifacts excluded BEFORE the size factor: a 2-source-file commit that also
    // regenerates pnpm-lock.yaml is n=2 evidence, not n=3 (the lockfile would dilute every pair's weight).
    const files = [...new Set(commit.files)].filter((f) => !isGeneratedArtifact(f));
    const n = files.length;
    if (n < 2 || n > opts.maxCommitFiles) continue;

    const ageSec = Math.max(0, nowSec - commit.tsSec);
    // halfLifeSec ≤ 0 ⇒ no decay (=1). NaN guard: 0.5^(0/0)=NaN would poison the edge weight and
    // silently drop the neighbor downstream (squash(NaN)=NaN).
    const recency = halfLifeSec > 0 ? Math.pow(0.5, ageSec / halfLifeSec) : 1;
    const sizeFactor = 1 / (n - 1);
    const contribution = recency * sizeFactor;

    files.sort();
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = files[i]!;
        const b = files[j]!;
        const key = `${a} ${b}`;
        const cur = acc.get(key);
        if (cur) {
          cur.weight += contribution;
          cur.count += 1;
        } else {
          acc.set(key, { a, b, weight: contribution, count: 1 });
        }
      }
    }
  }

  return [...acc.values()].filter((p) => p.count >= opts.minPairCount);
}

// SOH control byte: unambiguously marks commit-header lines in `--name-status` output (no real
// path/timestamp line begins with it). JS escape keeps the source printable.
const RECORD = '';

/** One parsed `--name-status` entry. For a rename (`R`), `path` is the NEW path and `oldPath` the source. */
export interface LogEntry {
  status: string;
  path: string;
  oldPath?: string;
}

/** A commit as parsed from `git log --name-status`: timestamp + its raw status entries. */
export interface ParsedCommit {
  tsSec: number;
  entries: LogEntry[];
}

/**
 * Parse `git log --no-merges --name-status --pretty=format:<SOH>%ct` into per-commit entries. Pure.
 * A rename line is `R<score>\t<old>\t<new>` and a copy `C<score>\t<src>\t<dst>`; everything else is
 * `<status>\t<path>`. Trailing `\r` (Windows checkouts) is trimmed off every path field.
 */
export function parseLogNameStatus(stdout: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  let current: ParsedCommit | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith(RECORD)) {
      current = { tsSec: Number(line.slice(1)) || 0, entries: [] };
      commits.push(current);
    } else if (line.trim() !== '' && current) {
      const parts = line.split('\t');
      const status = parts[0] ?? '';
      if (status.startsWith('R') || status.startsWith('C')) {
        const oldP = parts[1]?.trim();
        const newP = parts[2]?.trim();
        // Only a rename (R) aliases the old path; a copy (C) leaves its source untouched.
        if (newP) current.entries.push({ status, path: newP, ...(status.startsWith('R') && oldP ? { oldPath: oldP } : {}) });
      } else {
        const p = parts[1]?.trim();
        if (p) current.entries.push({ status, path: p });
      }
    }
  }
  return commits;
}

/**
 * Fold renames so a file's PRE-rename history attributes to its CURRENT path — the fix for co-change
 * being lost across a rename. Pure. Walks commits NEWEST→OLDEST (git log's default order), carrying an
 * alias map; each commit's touched paths are resolved through the current alias, THEN that commit's own
 * renames (`old → new`) register `alias[old] = resolve(new)` for the OLDER commits still to come.
 * Registering AFTER emitting is what makes it temporally correct: a path later REUSED for a different
 * file (a newer commit, processed first) is never mis-mapped, and A→B→C chains fold transitively.
 */
export function foldRenames(commits: ParsedCommit[]): CommitRecord[] {
  const alias = new Map<string, string>();
  const resolve = (p: string): string => {
    let cur = p;
    // Bounded chase (cycle guard): a pathological rename cycle can never spin forever.
    for (let i = 0; i < 10_000 && alias.has(cur); i++) cur = alias.get(cur)!;
    return cur;
  };
  const out: CommitRecord[] = [];
  for (const c of commits) {
    out.push({ tsSec: c.tsSec, files: c.entries.map((e) => resolve(e.path)) });
    for (const e of c.entries) {
      if (e.oldPath && e.status.startsWith('R')) alias.set(e.oldPath, resolve(e.path));
    }
  }
  return out;
}

/**
 * Read commit history (timestamp + touched files) via git, with renames FOLLOWED (`foldRenames`): a
 * renamed file's pre-rename commits attribute to its current path. `maxCommits` 0 = full; `sinceRef`
 * restricts to `sinceRef..HEAD` (ADR-26). Merges excluded; `-M` surfaces renames as `R` status lines.
 */
export async function readCommits(cwd: string, maxCommits: number, sinceRef?: string): Promise<CommitRecord[]> {
  const args = ['log', '--no-merges', '--name-status', '-M', `--pretty=format:${RECORD}%ct`];
  if (maxCommits > 0) args.push('-n', String(maxCommits));
  if (sinceRef) args.push(`${sinceRef}..HEAD`);
  const { stdout } = await pexec('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER });
  return foldRenames(parseLogNameStatus(stdout));
}

/** Resolve the current HEAD sha (for incremental update bookkeeping). */
export async function headSha(cwd: string): Promise<string> {
  try {
    // Retry a transient SPAWN failure but never a non-zero exit — the SAME policy as ingest's `runGit`.
    // Without it a momentary EAGAIN returns '' → empty `Meta.headSha` → next index can't diff and forces a full rebuild.
    const { stdout } = await retryTransientSpawn(() => pexec('git', ['rev-parse', 'HEAD'], { cwd }));
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Working-tree source files git does NOT ignore — repo-relative POSIX paths (match `File.id` as-is).
 * `--cached` + `--others` + `--exclude-standard` = working tree minus `.gitignore`d, so indexing respects
 * `.gitignore` while still indexing a brand-new uncommitted file. `-z` (NUL-delimited) survives odd path
 * names. Returns null when `cwd` isn't a git repo → caller falls back to a filesystem walk.
 */
export async function listWorktreeFiles(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await pexec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd, maxBuffer: GIT_MAX_BUFFER });
    return stdout.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** Indexable source files added/modified/deleted between `sha` and HEAD (ADR-25). `renamed` pairs the
 *  old→new of a rename (both sides indexable) so co-change edges + knowledge anchors can migrate. */
export interface ChangedFiles {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}

/** Parse `git diff --name-status` output into added/modified/deleted (+ rename pairs). Pure (unit-tested). */
export function parseNameStatus(stdout: string): ChangedFiles {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (status.startsWith('R')) {
      const oldP = parts[1];
      const newP = parts[2];
      if (oldP && isIndexable(oldP)) deleted.push(oldP);
      if (newP && isIndexable(newP)) added.push(newP);
      // Pair the rename for durable migration — only when BOTH sides are indexable source (a rename
      // across an unindexed extension isn't a source-file rename whose edges/anchors we can carry).
      if (oldP && newP && isIndexable(oldP) && isIndexable(newP)) renamed.push({ from: oldP, to: newP });
    } else if (status.startsWith('C')) {
      // Copy (diff.renames=copies): source untouched; index only the new path (parts[2]).
      const newP = parts[2];
      if (newP && isIndexable(newP)) added.push(newP);
    } else {
      const p = parts[1];
      if (!p || !isIndexable(p)) continue;
      if (status.startsWith('A')) added.push(p);
      else if (status.startsWith('D')) deleted.push(p);
      else modified.push(p);
    }
  }
  return { added, modified, deleted, renamed };
}

/**
 * Source files changed since `sha` (`git diff --name-status -M`). Renames split into delete(old)+add(new)
 * AND paired in `renamed` (so the old node's co-change edges can migrate to the new node); copies index
 * the new path. Returns `null` when the diff can't be computed (force-push) — caller falls back to a full build.
 */
export async function changedSourceFilesSince(cwd: string, sha: string): Promise<ChangedFiles | null> {
  let stdout: string;
  try {
    // `--` terminates options/revisions so a stored sha can never be read as a flag or a pathspec.
    ({ stdout } = await pexec('git', ['diff', '--name-status', '-M', sha, 'HEAD', '--'], { cwd, maxBuffer: GIT_MAX_BUFFER }));
  } catch {
    return null;
  }
  return parseNameStatus(stdout);
}

/** How many commits HEAD is ahead of `sha` (the graph's staleness). -1 if unknown. */
export async function commitsBehind(cwd: string, sha: string): Promise<number> {
  try {
    const { stdout } = await pexec('git', ['rev-list', '--count', `${sha}..HEAD`], { cwd });
    return Number(stdout.trim()) || 0;
  } catch {
    return -1;
  }
}
