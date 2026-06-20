/** A raw PR review comment pulled from GitHub (the analysis source unit). */
export interface RawComment {
  id: string;
  prNumber: number;
  /** Whether the PR that carried this comment was merged (the "shipped" signal). */
  prMerged: boolean;
  /** The PR author's login (ADR-50) — the reply-agreement confirm requires the agreeing reply to come from the PR author. */
  prAuthor?: string;
  path?: string;
  line?: number;
  body: string;
  /** GitHub marked this comment outdated — its hunk was modified by a later commit. The basis for an
   *  *observed* `fixed` outcome (see `outcomeFor`); a confirm only when paired with `prMerged`, else abstain. */
  outdated?: boolean;
  /** The diff hunk the comment was attached to — the "code-before" half of the triple. */
  diffHunk?: string;
  author?: string;
  createdAt?: string;
  inReplyToId?: number;
  /** Replies in the same review thread — the connected agent reads these (via `analyze_scan`) to decide skip vs store. */
  replies?: { author?: string; body: string }[];
}

/** A lesson learned this run (title + where it's anchored), not just a count. `files` = distinct source
 *  files the comments touched; symbol-level memory accrues from live-review accepts (ADR-47). */
export interface LearnedLesson {
  title: string;
  scope: 'global' | 'repo';
  /** Provenance comments backing the lesson (the cluster size). */
  incidents: number;
  /** Distinct source files those comments concern — "anchored to N files of your code". */
  files: number;
  action: 'minted' | 'reinforced';
}
