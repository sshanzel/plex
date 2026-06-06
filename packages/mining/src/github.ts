import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RawComment } from './types';

const pexec = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export interface PrRef {
  number: number;
  mergedAt: string | null;
}
interface GhComment {
  id: number;
  path?: string;
  line?: number;
  original_line?: number;
  body?: string;
  diff_hunk?: string;
  user?: { login?: string };
  created_at?: string;
  in_reply_to_id?: number;
}

/** List PRs (most recent first) via `gh`, run inside the target repo. */
export async function listPrs(opts: {
  cwd?: string;
  maxPrs: number;
  state?: 'merged' | 'all';
}): Promise<PrRef[]> {
  const cwd = opts.cwd ?? process.cwd();
  const state = opts.state ?? 'merged';
  const { stdout } = await pexec(
    'gh',
    ['pr', 'list', '--state', state, '--limit', String(opts.maxPrs || 100), '--json', 'number,mergedAt'],
    { cwd, maxBuffer: MAX_BUFFER },
  );
  return JSON.parse(stdout) as PrRef[];
}

/** Fetch the review comments for a single PR (best-effort). */
export async function fetchCommentsForPr(cwd: string, pr: PrRef): Promise<RawComment[]> {
  try {
    const { stdout } = await pexec(
      'gh',
      ['api', '--paginate', `repos/{owner}/{repo}/pulls/${pr.number}/comments`],
      { cwd, maxBuffer: MAX_BUFFER },
    );
    const raw = JSON.parse(stdout) as GhComment[];
    return raw.map((c) => ({
      id: String(c.id),
      prNumber: pr.number,
      prMerged: pr.mergedAt != null,
      path: c.path,
      line: c.line ?? c.original_line,
      body: c.body ?? '',
      diffHunk: c.diff_hunk,
      author: c.user?.login,
      createdAt: c.created_at,
      inReplyToId: c.in_reply_to_id,
    }));
  } catch {
    return [];
  }
}
