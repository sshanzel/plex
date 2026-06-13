import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isTransientSpawnError, retryTransientSpawn, type NormalizedDiff } from '@plex/core';
import { normalizeUnifiedDiff, addedTextByFile, type ChangedFileText } from './normalize';

const pexec = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

// The retry policy is shared in @plex/core so this and @plex/code-graph (`headSha`) can't drift apart
// (the audit found code-graph's copy un-retried). `isTransientSpawnError` is re-exported for the
// existing local.test.ts and any caller that imported it from here.
export { isTransientSpawnError };

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await retryTransientSpawn(() => pexec('git', args, { cwd, maxBuffer: MAX_BUFFER }));
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

/** The current HEAD commit SHA — keys a review round (ADR-23). Empty string if unavailable. */
export async function getHeadSha(cwd: string): Promise<string> {
  try {
    return (await runGit(['rev-parse', 'HEAD'], cwd)).trim();
  } catch {
    return '';
  }
}

/**
 * Per-file added-line text changed between two commits (`from..to`) — the inter-round
 * delta whose content gets embedded for semantic change attribution (ADR-23). Best-effort.
 */
export async function getChangedFileTexts(cwd: string, fromSha: string, toSha: string): Promise<ChangedFileText[]> {
  try {
    const text = await runGit(['diff', `${fromSha}..${toSha}`], cwd);
    return addedTextByFile(text);
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
