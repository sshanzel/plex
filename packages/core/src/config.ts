/**
 * Reviewer configuration. Sensible local-first defaults; everything overridable.
 */

export type EmbeddingProviderName = 'openai' | 'voyage' | 'ollama' | 'fake';

export interface EmbeddingConfig {
  provider: EmbeddingProviderName;
  /** Model id, provider-specific (e.g. `voyage-code-3`, `text-embedding-3-small`). */
  model?: string;
  /** Env var holding the API key (kept out of config so secrets never get serialized). */
  apiKeyEnv?: string;
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

export interface ReviewerConfig {
  /** Per-repo Kùzu data directory (default `.reviewer` under each repo). */
  dataDir: string;
  /** Global, cross-repo knowledge base directory (ADR-07: knowledge is shared). */
  knowledgeDir: string;
  embedding: EmbeddingConfig;
  /** Ephemeral graph layer; optional — falls back to in-process if unreachable. */
  falkordb: {
    enabled: boolean;
    url: string;
  };
  coChange: CoChangeConfig;
  /** Blast-radius expansion controls. */
  neighborhood: {
    maxHops: number;
    maxNeighbors: number;
    /** Minimum aggregate coupling score to include a neighbor. */
    minScore: number;
  };
}

import os from 'node:os';
import path from 'node:path';

export const defaultConfig: ReviewerConfig = {
  dataDir: '.plex',
  knowledgeDir: path.join(os.homedir(), '.plex', 'knowledge'),
  embedding: {
    provider: 'fake',
    model: 'voyage-code-3',
    apiKeyEnv: 'VOYAGE_API_KEY',
  },
  falkordb: {
    enabled: false,
    url: 'redis://localhost:6379',
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
};

export function resolveConfig(overrides: Partial<ReviewerConfig> = {}): ReviewerConfig {
  return {
    ...defaultConfig,
    ...overrides,
    embedding: { ...defaultConfig.embedding, ...overrides.embedding },
    falkordb: { ...defaultConfig.falkordb, ...overrides.falkordb },
    coChange: { ...defaultConfig.coChange, ...overrides.coChange },
    neighborhood: { ...defaultConfig.neighborhood, ...overrides.neighborhood },
  };
}
