import type { ReviewerConfig, RankedFinding, NormalizedDiff, LineRange } from '@plex/core';
import { getPrDiff, postPrReview, type PrReviewComment } from '@plex/ingest';
import type { BrainFinding } from './brain';

/** Identity for dedup across rounds — file + new-side line + normalized title. */
const key = (file: string, line: number, title: string): string => `${file}:${line}:${title.trim().toLowerCase()}`;

/** Changed file → new-side line ranges (the only lines GitHub allows inline comments on). */
function changedRanges(diff: NormalizedDiff): Map<string, LineRange[]> {
  const m = new Map<string, LineRange[]>();
  for (const f of diff.files) m.set(f.path, f.hunks.flatMap((h) => h.newRanges));
  return m;
}
const onChangedLine = (ranges: LineRange[] | undefined, line: number): boolean =>
  !!ranges && ranges.some((r) => r.start <= line && line <= r.end);

export interface ReviewPayload {
  /** Review summary body — overview + awareness + findings not anchorable inline. */
  body: string;
  /** Inline comments on changed lines. */
  comments: PrReviewComment[];
  /** New findings posted this round (inline + summary). */
  count: number;
}

/**
 * PURE: turn the ranked stream into a single GitHub review payload.
 * - Never posts `suppressed`/waived findings; skips `nit`s when `skipNits`.
 * - Dedups against prior rounds' findings (post only what's new) — no round-2 spam.
 * - Anchors a finding inline when its line is in the diff; everything else (coupled /
 *   blast-radius files, awareness flags) folds into the summary body.
 */
export function buildReviewPayload(
  ranked: RankedFinding[],
  opts: { priorFindings: BrainFinding[]; changed: Map<string, LineRange[]>; skipNits: boolean; round: number },
): ReviewPayload {
  const seen = new Set(opts.priorFindings.map((p) => key(p.file ?? '', p.line ?? 0, p.title)));
  const fresh = ranked.filter(
    (f) =>
      f.triage !== 'suppressed' &&
      !(opts.skipNits && f.severity === 'nit') &&
      !seen.has(key(f.location.file, f.location.startLine, f.title)),
  );

  const comments: PrReviewComment[] = [];
  const elsewhere: string[] = [];
  const awareness: string[] = [];
  for (const f of fresh) {
    const head = `**[${f.severity}]** ${f.title}`;
    const at = `\`${f.location.file}:${f.location.startLine}\``;
    const tail = f.body ? `\n${f.body}` : '';
    if (f.severity === 'awareness') {
      awareness.push(`- ${head} — ${at}${tail}`);
    } else if (onChangedLine(opts.changed.get(f.location.file), f.location.startLine)) {
      comments.push({ path: f.location.file, line: f.location.startLine, body: `${head}${tail}\n\n_— Plex (${f.source})_` });
    } else {
      elsewhere.push(`- ${head} — ${at}${tail}`);
    }
  }

  const parts: string[] = [`### Plex review — round ${opts.round}`, `${fresh.length} new finding(s).`];
  if (elsewhere.length) parts.push('', '**Coupled / not on changed lines:**', ...elsewhere);
  if (awareness.length) parts.push('', '**Worth confirming (awareness — intentional? say so):**', ...awareness);
  parts.push('', '_Posted by Plex. Triage with the `plex-review-responder` skill; it closes the learning loop._');
  return { body: parts.join('\n'), comments, count: fresh.length };
}

/**
 * Post the ranked findings to a PR as one review (best-effort — never breaks a review).
 * Resolves the PR diff to anchor inline comments, dedups against prior rounds, posts, and
 * no-ops when there's nothing new.
 */
export async function postFindingsToPr(
  cwd: string,
  config: ReviewerConfig,
  pr: number | string,
  ranked: RankedFinding[],
  priorFindings: BrainFinding[],
  round: number,
): Promise<{ posted: number } | null> {
  try {
    const diff = await getPrDiff({ pr, cwd });
    const payload = buildReviewPayload(ranked, {
      priorFindings,
      changed: changedRanges(diff),
      skipNits: config.autoCommentSkipNits,
      round,
    });
    if (payload.count === 0) return { posted: 0 };
    await postPrReview(cwd, pr, payload.body, payload.comments);
    return { posted: payload.count };
  } catch {
    return null; // a posting failure must never break the review
  }
}
