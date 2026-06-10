/**
 * Reviewer configuration. Sensible local-first defaults; everything overridable.
 */

// `none` = no embeddings configured (knowledge features disabled until you pick one).
// `fake` is a deterministic test-only embedder — never used in real operation.
export type EmbeddingProviderName = 'voyage' | 'openai' | 'gemini' | 'ollama' | 'none' | 'fake';

export interface EmbeddingConfig {
  provider: EmbeddingProviderName;
  /** Model id, provider-specific (e.g. `voyage-code-3`, `text-embedding-3-small`). */
  model?: string;
  /** Env var holding the API key (preferred — keeps secrets out of serialized config). */
  apiKeyEnv?: string;
  /** Direct API key from `~/.plex/config.json` (ADR-29). Used if no env key is present. */
  apiKey?: string;
  /** Override base URL (e.g. Ollama at http://localhost:11434). */
  baseUrl?: string;
}

export interface CoChangeConfig {
  /**
   * Commits touching more files than this contribute ~0 to coupling — kills the N²
   * blowup from lint/format/license sweeps and denoises (ADR-06, plan §2).
   */
  maxCommitFiles: number;
  /** Recency half-life in days; older co-changes decay. */
  halfLifeDays: number;
  /** Prune pairs co-occurring fewer than this many times. */
  minPairCount: number;
  /** How many commits back to crawl on first backfill (0 = full history). */
  maxCommits: number;
}

/** Generative LLM used ONLY by the offline analysis/distillation pipeline (ADR-02). */
export type LlmProviderName = 'heuristic' | 'claude-cli' | 'anthropic' | 'openai';
export interface LlmConfig {
  provider: LlmProviderName;
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
}

export interface AnalyzeConfig {
  /** Merged PRs to scan, most recent first (0 = as many as gh returns). */
  maxPrs: number;
  /**
   * Cosine threshold to group review comments into one pitfall cluster. Tuned for
   * code-specialized embeddings (voyage-code-3): related comments sit ~0.86, unrelated
   * ~0.40, but the running-mean centroid concentrates the embeddings' anisotropic common
   * component, so a *too-low* threshold makes the first cluster a SINK that swallows
   * everything (0.6 collapsed 325 real comments into 1 cluster → 0 pitfalls). ~0.8 keeps
   * clusters tight. Override per-model with `plex analyze --threshold`.
   */
  clusterThreshold: number;
  /**
   * Minimum cluster size sent to the distiller. Default 1: since the LLM is the quality
   * gate (it SKIPs non-lessons), clustering merges duplicates rather than dropping lone
   * but valuable comments. Raise to 2+ to require corroboration (fewer LLM calls).
   */
  minClusterSize: number;
}

export interface ReviewerConfig {
  /**
   * Where per-repo data lives. Empty (default) = centralized `~/.plex/repos/<id>` —
   * NOTHING is written inside the user's repo. A relative value (e.g. `.plex`) opts into
   * co-locating it in-repo; an absolute value is used as the repos root. See `repoPaths`.
   */
  dataDir: string;
  /** Global, cross-repo knowledge base directory (ADR-07: knowledge is shared). */
  knowledgeDir: string;
  embedding: EmbeddingConfig;
  coChange: CoChangeConfig;
  /** Blast-radius expansion controls. */
  neighborhood: {
    maxHops: number;
    maxNeighbors: number;
    /** Minimum aggregate coupling score to include a neighbor. */
    minScore: number;
  };
  /** Generative LLM for analysis/distillation (offline only). */
  llm: LlmConfig;
  analyze: AnalyzeConfig;
  /**
   * When reviewing a PR (`source: 'pr'`), post the ranked findings to the GitHub PR as a
   * single review (summary body + inline comments on changed lines), deduped per round via
   * the brain. Off by default; opt in via `PLEX_AUTO_COMMENT=true` or `~/.plex/config.json`.
   * Non-PR reviews never post. (`plex review --pr N --post` posts on demand regardless.)
   */
  autoComment: boolean;
  /**
   * Skip `nit`-severity findings when auto-commenting. Off by default — nits carry value
   * (small but real), so they're posted unless a team opts out. Suppressed/waived findings
   * are never posted regardless. (`PLEX_AUTO_COMMENT_SKIP_NITS=true`.)
   */
  autoCommentSkipNits: boolean;
  /**
   * Parallel-review guardrail (docs/design/parallel-review.md): when `get_review_context`
   * should advise fanning out the review into subagents vs a single reviewer, decided from
   * the coupling graph. Conservative — defaults to single unless the change is big AND splits
   * into independent coupled clusters.
   */
  reviewPlan: {
    /** Below this many changed files → single-agent review. */
    minFiles: number;
    /** Below this review surface (changed LOC) → single-agent. */
    minSurface: number;
    /** Cap on parallel reviewers (smallest clusters merge to fit). */
    maxAgents: number;
    /** Clusters smaller than this are folded in, never given their own reviewer. */
    minClusterFiles: number;
  };
}

import os from 'node:os';
import path from 'node:path';

export const defaultConfig: ReviewerConfig = {
  dataDir: '', // centralized: ~/.plex/repos/<id> — never writes inside the user's repo
  knowledgeDir: path.join(os.homedir(), '.plex', 'knowledge'),
  embedding: {
    // Real operation requires a real provider; knowledge features stay disabled until
    // one is set (PLEX_EMBEDDING_PROVIDER). Never defaults to the test-only fake embedder.
    provider: 'none',
  },
  coChange: {
    maxCommitFiles: 25,
    halfLifeDays: 365,
    minPairCount: 2,
    maxCommits: 5000,
  },
  neighborhood: {
    maxHops: 2,
    maxNeighbors: 40,
    minScore: 0.05,
  },
  llm: {
    // Analysis distillation is LLM-only (ADR-20). Default to the local `claude` CLI so it
    // rides the Claude subscription with no API key; falls back to ANTHROPIC_API_KEY only
    // if the provider is explicitly set to `anthropic`.
    provider: 'claude-cli',
    model: 'claude-haiku-4-5-20251001',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  analyze: {
    maxPrs: 100,
    clusterThreshold: 0.8, // tuned for code embeddings; <~0.7 sinks everything into one cluster (see AnalyzeConfig)
    minClusterSize: 1,
  },
  autoComment: false, // opt-in: PLEX_AUTO_COMMENT=true / ~/.plex/config.json
  autoCommentSkipNits: false, // nits have value — posted by default; opt out via PLEX_AUTO_COMMENT_SKIP_NITS
  reviewPlan: { minFiles: 6, minSurface: 150, maxAgents: 5, minClusterFiles: 2 },
};

export function resolveConfig(overrides: Partial<ReviewerConfig> = {}): ReviewerConfig {
  return {
    ...defaultConfig,
    ...overrides,
    embedding: { ...defaultConfig.embedding, ...overrides.embedding },
    coChange: { ...defaultConfig.coChange, ...overrides.coChange },
    neighborhood: { ...defaultConfig.neighborhood, ...overrides.neighborhood },
    llm: { ...defaultConfig.llm, ...overrides.llm },
    analyze: { ...defaultConfig.analyze, ...overrides.analyze },
    reviewPlan: { ...defaultConfig.reviewPlan, ...overrides.reviewPlan },
  };
}
