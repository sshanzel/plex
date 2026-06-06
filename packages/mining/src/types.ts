/** A raw PR review comment pulled from GitHub (the mining source unit). */
export interface RawComment {
  id: string;
  prNumber: number;
  /** Whether the PR that carried this comment was merged (the "shipped" signal). */
  prMerged: boolean;
  path?: string;
  line?: number;
  body: string;
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

export interface MineResult {
  prsScanned: number;
  comments: number;
  substantive: number;
  clusters: number;
  /** Pitfalls the LLM judged worth storing. */
  pitfalls: number;
  /** Clusters the LLM judged NOT worth storing. */
  skipped: number;
  incidents: number;
  /** Name of the LLM distiller that ran (claude-cli, anthropic, openai, …). */
  distiller: string;
}
