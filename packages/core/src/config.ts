/** Reviewer configuration. Local-first defaults; everything overridable. */

// `none` = no embeddings (knowledge features disabled); `fake` = deterministic test-only embedder, never in real operation.
export type EmbeddingProviderName = 'voyage' | 'openai' | 'gemini' | 'ollama' | 'none' | 'fake';

export interface EmbeddingConfig {
  provider: EmbeddingProviderName;
  model?: string;
  /** Env var holding the API key (preferred — keeps secrets out of serialized config). */
  apiKeyEnv?: string;
  /** Direct API key from `~/.plex/config.json` (ADR-29); used if no env key is present. */
  apiKey?: string;
  baseUrl?: string;
}

export interface CoChangeConfig {
  /** Commits touching more files than this contribute ~0 to coupling — kills the N² sweep blowup (ADR-06). */
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
   * Cosine threshold to group review comments into one pitfall cluster. A *too-low* threshold makes
   * the first cluster a SINK that swallows everything (0.6 collapsed 325 comments into 1 → 0 pitfalls);
   * ~0.8 keeps clusters tight. Override per-model with `plex analyze --threshold`.
   */
  clusterThreshold: number;
  /** Minimum cluster size sent to the distiller. Default 1: the LLM is the quality gate (SKIPs non-lessons). */
  minClusterSize: number;
}

export interface ReviewerConfig {
  /**
   * Where per-repo data lives. Empty (default) = centralized `~/.plex/repos/<id>` (nothing written
   * inside the user's repo); relative = in-repo opt-in; absolute = repos root.
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
  /** Post ranked findings back to a reviewed GitHub PR (deduped per round). Off by default; non-PR reviews never post. */
  autoComment: boolean;
  /** Skip `nit`-severity findings when auto-commenting. Off by default. */
  autoCommentSkipNits: boolean;
  /** Parallel-review guardrail: single vs fan-out, decided from the coupling graph (docs/design/parallel-review.md). */
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
  /** Learned-suppression recency decay, by verb — a `reject` fades, a `waive` persists; wall-time clock (ADR-41). */
  suppression: {
    /** Half-life (days) of a `reject` dismissal — short. */
    rejectHalfLifeDays: number;
    /** Half-life (days) of a `waive` dismissal — long. */
    waiveHalfLifeDays: number;
  };
  /** Positive-pitfall recency decay (ADR-42): reinforcement recency-weighted, retrieval tilted, quiet thin pitfalls pruned (provenance survives). */
  decay: {
    /** Half-life (days) for an incident's reinforcement weight + the retrieval tilt. */
    halfLifeDays: number;
    /** Retrieval recency multiplier never drops below this — an old-but-real lesson still surfaces. */
    retrievalTiltFloor: number;
    /** Prune a pitfall whose recency-decayed confidence falls below this (AND it's gone quiet). */
    pruneFloor: number;
    /** Don't prune until the last incident is at least this old (days). */
    pruneMinAgeDays: number;
  };
  /** Optional local visualization daemon (ADR-45, `plex serve`) — a viewer, on-demand by default. */
  ui: {
    autoStart: boolean;
    /** Default port for `plex serve`; also overridable per-launch by `--port` / `PLEX_UI_PORT`. */
    port: number;
  };
}

import os from 'node:os';
import path from 'node:path';

export const defaultConfig: ReviewerConfig = {
  dataDir: '', // centralized: ~/.plex/repos/<id> — never writes inside the user's repo
  knowledgeDir: path.join(os.homedir(), '.plex', 'knowledge'),
  embedding: {
    provider: 'none', // never defaults to the test-only fake embedder
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
    // Analysis distillation is LLM-only (ADR-20); default to the local `claude` CLI (subscription, no key).
    provider: 'claude-cli',
    model: 'claude-haiku-4-5-20251001',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  analyze: {
    maxPrs: 100,
    clusterThreshold: 0.8, // <~0.7 sinks everything into one cluster (see AnalyzeConfig)
    minClusterSize: 1,
  },
  autoComment: false,
  autoCommentSkipNits: false,
  reviewPlan: { minFiles: 6, minSurface: 150, maxAgents: 5, minClusterFiles: 2 },
  suppression: { rejectHalfLifeDays: 30, waiveHalfLifeDays: 365 },
  decay: { halfLifeDays: 365, retrievalTiltFloor: 0.5, pruneFloor: 0.1, pruneMinAgeDays: 365 },
  ui: { autoStart: false, port: 2288 },
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
    suppression: { ...defaultConfig.suppression, ...overrides.suppression },
    decay: { ...defaultConfig.decay, ...overrides.decay },
    ui: { ...defaultConfig.ui, ...overrides.ui },
  };
}
