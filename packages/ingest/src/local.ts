import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NormalizedDiff } from '@plex/core';
import { normalizeUnifiedDiff } from './normalize';

const pexec = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await pexec('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
}

/** Commit subjects in `baseRef..HEAD` (the change's narrative, for branch reviews). */
export async function getCommitSubjects(cwd: string, baseRef: string, limit = 20): Promise<string[]> {
  try {
    const out = await runGit(['log', `${baseRef}..HEAD`, '--no-merges', '--format=%s', '-n', String(limit)], cwd);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export type LocalDiffMode = 'working' | 'staged' | 'branch';

export interface LocalDiffOptions {
  cwd?: string;
  /** `working` = unstaged+staged vs HEAD, `staged` = index vs HEAD, `branch` = base...HEAD. */
  mode?: LocalDiffMode;
  /** Base ref for `branch` mode (default `main`). */
  baseRef?: string;
}

/** Produce a normalized diff from the local working tree / index / branch. */
export async function getLocalDiff(opts: LocalDiffOptions = {}): Promise<NormalizedDiff> {
  const cwd = opts.cwd ?? process.cwd();
  const mode = opts.mode ?? 'working';

  let args: string[];
  let baseRef: string;
  if (mode === 'staged') {
    args = ['diff', '--cached'];
    baseRef = 'HEAD (staged)';
  } else if (mode === 'branch') {
    baseRef = opts.baseRef ?? 'main';
    args = ['diff', `${baseRef}...HEAD`];
  } else {
    args = ['diff', 'HEAD'];
    baseRef = 'HEAD (working)';
  }

  const text = await runGit(args, cwd);
  return normalizeUnifiedDiff(text, baseRef);
}
