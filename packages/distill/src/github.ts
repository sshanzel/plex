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

/**
 * Group a flat list of review comments into threads: each top-level comment carries its
 * replies (the discussion that reveals the outcome). PURE — unit-tested. Replies whose
 * root can't be resolved are dropped.
 */
export function groupThreads(flat: RawComment[]): RawComment[] {
  const byId = new Map(flat.map((c) => [c.id, c]));
  const tops = flat
    .filter((c) => c.inReplyToId == null)
    .map((c) => ({ ...c, replies: [] as { author?: string; body: string }[] }));
  const topById = new Map(tops.map((t) => [t.id, t]));

  const rootId = (c: RawComment): string => {
    let cur = c;
    const seen = new Set<string>();
    while (cur.inReplyToId != null && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = byId.get(String(cur.inReplyToId));
      if (!parent) break;
      cur = parent;
    }
    return cur.id;
  };

  for (const c of flat) {
    if (c.inReplyToId == null) continue;
    topById.get(rootId(c))?.replies!.push({ author: c.author, body: c.body });
  }
  return tops;
}

/** Fetch the review comments for a single PR, grouped into threads (best-effort). */
export async function fetchCommentsForPr(cwd: string, pr: PrRef): Promise<RawComment[]> {
  try {
    const { stdout } = await pexec(
      'gh',
      ['api', '--paginate', `repos/{owner}/{repo}/pulls/${pr.number}/comments`],
      { cwd, maxBuffer: MAX_BUFFER },
    );
    const flat: RawComment[] = (JSON.parse(stdout) as GhComment[]).map((c) => ({
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
    return groupThreads(flat);
  } catch {
    return [];
  }
}
