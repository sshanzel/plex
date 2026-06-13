import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDiff } from '@plex/core';
import { normalizeUnifiedDiff } from './normalize';

const pexec = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

/** One inline review comment, anchored to a changed line (new side). */
export interface PrReviewComment {
  path: string;
  line: number;
  body: string;
}

/**
 * Post ONE PR review (event=COMMENT) with a summary body + inline comments, via `gh api`.
 * The JSON goes through a temp file (execFile can't pipe stdin). Never `--approve` /
 * `--request-changes`. Throws on failure — callers post best-effort.
 */
export async function postPrReview(
  cwd: string,
  pr: number | string,
  body: string,
  comments: PrReviewComment[],
): Promise<void> {
  const payload = JSON.stringify({
    event: 'COMMENT',
    body,
    comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
  });
  const dir = mkdtempSync(join(tmpdir(), 'plex-review-'));
  const file = join(dir, 'review.json');
  try {
    writeFileSync(file, payload, 'utf8');
    await pexec('gh', ['api', '--method', 'POST', `repos/{owner}/{repo}/pulls/${pr}/reviews`, '--input', file], {
      cwd,
      maxBuffer: MAX_BUFFER,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

export interface PrMeta {
  title?: string;
  body?: string;
  url?: string;
}

/** Fetch a PR's title/description/url (the stated motivation) via `gh`. Best-effort. */
export async function getPrMeta(opts: PrDiffOptions): Promise<PrMeta> {
  const cwd = opts.cwd ?? process.cwd();
  try {
    const { stdout } = await pexec('gh', ['pr', 'view', String(opts.pr), '--json', 'title,body,url'], {
      cwd,
      maxBuffer: MAX_BUFFER,
    });
    const j = JSON.parse(stdout) as PrMeta;
    return { title: j.title, body: j.body, url: j.url };
  } catch {
    return {};
  }
}

/** The PR's head commit SHA — keys a review round (ADR-23). Empty string if unavailable. */
export async function getPrHeadSha(opts: PrDiffOptions): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  try {
    const { stdout } = await pexec('gh', ['pr', 'view', String(opts.pr), '--json', 'headRefOid'], {
      cwd,
      maxBuffer: MAX_BUFFER,
    });
    return (JSON.parse(stdout) as { headRefOid?: string }).headRefOid ?? '';
  } catch {
    return '';
  }
}

/**
 * The PR's lifecycle state (`OPEN` | `CLOSED` | `MERGED`), or `''` on ANY gh failure — so a caller can
 * distinguish a *genuinely* closed/merged PR from a transient gh error (network/rate-limit/auth, or gh
 * missing on PATH). `getPrHeadSha` returning '' is ambiguous between the two; this disambiguates it (the
 * maintenance worker checks it before condemning a target as dead, ADR-43). Best-effort, like the others.
 */
export async function getPrState(opts: PrDiffOptions): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  try {
    const { stdout } = await pexec('gh', ['pr', 'view', String(opts.pr), '--json', 'state'], {
      cwd,
      maxBuffer: MAX_BUFFER,
    });
    return (JSON.parse(stdout) as { state?: string }).state ?? '';
  } catch {
    return '';
  }
}
