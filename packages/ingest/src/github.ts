import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NormalizedDiff } from '@plex/core';
import { normalizeUnifiedDiff } from './normalize';

const pexec = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export interface PrDiffOptions {
  pr: number | string;
  cwd?: string;
}

/**
 * Produce a normalized diff for a GitHub PR via the `gh` CLI.
 * ADR-14: a PR diff is the same thing as a local diff once normalized.
 */
export async function getPrDiff(opts: PrDiffOptions): Promise<NormalizedDiff> {
  const cwd = opts.cwd ?? process.cwd();
  const { stdout } = await pexec('gh', ['pr', 'diff', String(opts.pr)], {
    cwd,
    maxBuffer: MAX_BUFFER,
  });
  return normalizeUnifiedDiff(stdout, `pr/${opts.pr}`);
}
