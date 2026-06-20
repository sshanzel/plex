import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RawComment } from './types';

const pexec = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export interface PrRef {
  number: number;
  mergedAt: string | null;
  /** PR author login (ADR-50) — the reply-agreement confirm requires the agreeing reply to come from the PR author. */
  author?: string;
}
interface GhComment {
  id: number;
  path?: string;
  line?: number;
  original_line?: number;
  /** Diff position in the LATEST diff — `null` once the comment is outdated (its hunk changed). */
  position?: number | null;
  /** Diff position in the diff AT COMMENT TIME — persists even after the comment goes outdated. */
  original_position?: number | null;
  body?: string;
  diff_hunk?: string;
  user?: { login?: string };
  created_at?: string;
  in_reply_to_id?: number;
}

/**
 * GitHub's server-computed "outdated" signal: `position` null (hunk changed by a later commit) while
 * `original_position` persists. Conservative — absent/ambiguous fields return `false` (abstain), never a false "addressed".
 */
export function isOutdated(c: Pick<GhComment, 'position' | 'original_position'>): boolean {
  return c.position == null && c.original_position != null;
}

/** Parse `gh pr list --json` output into PR refs, naming the source on a parse/shape failure. */
export function parsePrList(stdout: string): PrRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = undefined;
  }
  // Validate the SHAPE, not just that JSON parsed: a valid-JSON non-array would cast through and throw far downstream.
  if (!Array.isArray(parsed)) {
    const preview = stdout.trim().slice(0, 200);
    throw new Error(`gh pr list did not return a JSON array (got: ${preview || '<empty>'}); is gh installed + authenticated?`);
  }
  // gh returns `author` as an object ({login, …}); normalize it to the login string for PrRef.
  type RawPr = { number: number; mergedAt: string | null; author?: { login?: string } | null };
  return (parsed as RawPr[]).map((p) => ({ number: p.number, mergedAt: p.mergedAt, author: p.author?.login }));
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
    ['pr', 'list', '--state', state, '--limit', String(opts.maxPrs || 100), '--json', 'number,mergedAt,author'],
    { cwd, maxBuffer: MAX_BUFFER },
  );
  return parsePrList(stdout);
}

/** Group a flat list of review comments into threads: each top-level comment carries its replies. Orphan replies are dropped. */
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
      prAuthor: pr.author,
      path: c.path,
      line: c.line ?? c.original_line,
      outdated: isOutdated(c),
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
