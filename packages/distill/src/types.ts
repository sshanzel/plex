/** A raw PR review comment pulled from GitHub (the analysis source unit). */
export interface RawComment {
  id: string;
  prNumber: number;
  /** Whether the PR that carried this comment was merged (the "shipped" signal). */
  prMerged: boolean;
  /** The PR author's login (ADR-50). The reply-agreement confirm requires the AGREEING reply to come
   *  from the PR author (the person who addressed the review) — not merely from someone other than the
   *  reviewer. Set from `PrRef.author`; absent when `gh` didn't surface it. */
  prAuthor?: string;
  path?: string;
  line?: number;
  body: string;
  /**
   * GitHub marked this review comment **outdated** — the diff hunk it was anchored to was MODIFIED
   * by a later commit (`position` went null while `original_position` persists). It's the strongest
   * signal we can read CHEAPLY (already in the comments payload, one API call, squash-merge-proof
   * since GitHub computes it server-side) that the flagged code was actually changed in response —
   * the basis for an *observed* `fixed` outcome instead of assuming "merged ⇒ accepted" (see
   * `outcomeFor`). Heuristic: an unrelated edit in the same hunk also outdates it, so it's a
   * confirm only when paired with `prMerged`, and we ABSTAIN (never refute) when it's absent.
   */
  outdated?: boolean;
  /** The diff hunk the comment was attached to — the "code-before" half of the triple. */
  diffHunk?: string;
  author?: string;
  createdAt?: string;
  inReplyToId?: number;
  /**
   * Replies in the same review thread — the discussion that reveals the real outcome
   * (e.g. a responder saying "don't do this" / "intentional" means the comment was
   * dismissed, not accepted). The LLM distiller reads these to decide skip vs store.
   */
  replies?: { author?: string; body: string }[];
}

/** A lesson learned this run — the payoff a user actually wants to SEE (titles + where it's anchored
 *  in their code), not just a count. `files` is the distinct source files the lesson's comments touched
 *  (mined incidents anchor to a file/line; symbol-level memory accrues from live-review accepts, ADR-47). */
export interface LearnedLesson {
  title: string;
  scope: 'global' | 'repo';
  /** Provenance comments backing the lesson (the cluster size). */
  incidents: number;
  /** Distinct source files those comments concern — "anchored to N files of your code". */
  files: number;
  action: 'minted' | 'reinforced';
}

export interface DistillResult {
  prsScanned: number;
  comments: number;
  substantive: number;
  clusters: number;
  /** NEW pitfalls minted (a principle not already in the store). */
  pitfalls: number;
  /** Existing pitfalls reinforced by a semantically-matching candidate (no duplicate minted). */
  reinforced: number;
  /** Clusters the LLM judged NOT worth storing. */
  skipped: number;
  incidents: number;
  /** Name of the LLM distiller that ran (claude-cli, anthropic, openai, …). */
  distiller: string;
  /** What was learned this run (titles + code-anchoring) — for a tangible payoff summary. */
  learned: LearnedLesson[];
}
