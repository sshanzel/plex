import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

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
  /** Recency half-life in days. */
  halfLifeDays: number;
  /** Drop pairs co-occurring fewer than this many times. */
  minPairCount: number;
  /** "now" in seconds, for recency decay (defaults to current time). */
  nowSec?: number;
}

/**
 * Aggregate commits into weighted co-change pairs — PURE (ADR-06, plan §2).
 *
 * Contribution per pair from a commit = recencyDecay × sizeFactor, where
 *   recencyDecay = 0.5 ^ (ageDays / halfLifeDays)   — older coupling counts less
 *   sizeFactor   = 1 / (fileCount - 1)              — a 2-file commit is strong
 *                                                     evidence; a 25-file one is noise.
 * Commits with < 2 or > maxCommitFiles files are skipped entirely.
 */
export function aggregateCoChange(commits: CommitRecord[], opts: AggregateOptions): CoChangePair[] {
  const nowSec = opts.nowSec ?? Date.now() / 1000;
  const halfLifeSec = opts.halfLifeDays * 86400;
  const acc = new Map<string, { a: string; b: string; weight: number; count: number }>();

  for (const commit of commits) {
    const files = [...new Set(commit.files)];
    const n = files.length;
    if (n < 2 || n > opts.maxCommitFiles) continue;

    const ageSec = Math.max(0, nowSec - commit.tsSec);
    const recency = Math.pow(0.5, ageSec / halfLifeSec);
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

// SOH control byte (written as a JS escape so the source stays printable). git emits
// it literally in pretty-format output, and no real path or timestamp line begins with
// it, so it unambiguously marks commit-header lines within `--name-only` output.
const RECORD = '';

/**
 * Read commit history (timestamp + touched files) via git. `maxCommits` of 0 = full
 * history. Merge commits are excluded. This is the only impure part of co-change.
 */
export async function readCommits(cwd: string, maxCommits: number): Promise<CommitRecord[]> {
  const args = ['log', '--no-merges', '--name-only', `--pretty=format:${RECORD}%ct`];
  if (maxCommits > 0) args.push('-n', String(maxCommits));
  const { stdout } = await pexec('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 });

  const commits: CommitRecord[] = [];
  let current: CommitRecord | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith(RECORD)) {
      current = { tsSec: Number(line.slice(1)) || 0, files: [] };
      commits.push(current);
    } else if (line.trim() !== '' && current) {
      // strip rename artifacts like "old => new" -> keep the new path
      const file = line.includes(' => ') ? line.replace(/.*=>\s*/, '').replace(/[}]/g, '') : line;
      current.files.push(file.trim());
    }
  }
  return commits;
}

/** Resolve the current HEAD sha (for incremental update bookkeeping). */
export async function headSha(cwd: string): Promise<string> {
  try {
    const { stdout } = await pexec('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim();
  } catch {
    return '';
  }
}
