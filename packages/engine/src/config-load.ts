import {
  resolveConfig,
  defaultConfig,
  type ReviewerConfig,
  type EmbeddingProviderName,
  type LlmProviderName,
} from '@plex/core';
import { readHomeConfig } from './home-config';

/** Parse a numeric env var; undefined/empty/non-finite → undefined (ignored, not 0). */
const numEnv = (v?: string): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Build a config from, in increasing precedence: defaults < `~/.plex/config.json` (written
 * by `plex init`) < environment variables < explicit overrides. The home config lets a user
 * set their embedding key once; env still wins for per-invocation overrides.
 *
 *   PLEX_DATA_DIR             per-repo data dir ('' = centralized ~/.plex/repos/<id>)
 *   PLEX_KNOWLEDGE_DIR        global knowledge base dir (default ~/.plex/knowledge)
 *   PLEX_EMBEDDING_PROVIDER   voyage | openai | gemini | ollama | none (default none)
 *   PLEX_LLM_PROVIDER         analysis distiller: claude-cli | anthropic | openai
 *   PLEX_LLM_MODEL            model id for the analysis distiller
 *   PLEX_SUPPRESSION_REJECT_HALFLIFE_DAYS  recency-decay half-life of a `reject` (default 30)
 *   PLEX_SUPPRESSION_WAIVE_HALFLIFE_DAYS   recency-decay half-life of a `waive` (default 365)
 */
export function loadConfig(overrides: Partial<ReviewerConfig> = {}): ReviewerConfig {
  const home = readHomeConfig();
  const env = process.env;
  const o: Partial<ReviewerConfig> = {};

  // --- home config (~/.plex/config.json) ---
  if (home.embedding?.provider) {
    o.embedding = {
      provider: home.embedding.provider,
      ...(home.embedding.apiKey ? { apiKey: home.embedding.apiKey } : {}),
      ...(home.embedding.model ? { model: home.embedding.model } : {}),
    };
  }
  if (home.llm?.provider) o.llm = { provider: home.llm.provider, ...(home.llm.model ? { model: home.llm.model } : {}) };
  // Suppression half-lives (ADR-41) — the documented tuning knob, so it must be reachable from the
  // home config (not just programmatic overrides). Collect home values; env may override below.
  const supp: { rejectHalfLifeDays?: number; waiveHalfLifeDays?: number } = {};
  if (typeof home.suppression?.rejectHalfLifeDays === 'number') supp.rejectHalfLifeDays = home.suppression.rejectHalfLifeDays;
  if (typeof home.suppression?.waiveHalfLifeDays === 'number') supp.waiveHalfLifeDays = home.suppression.waiveHalfLifeDays;

  // --- environment (overrides home) ---
  if (env.PLEX_DATA_DIR) o.dataDir = env.PLEX_DATA_DIR;
  if (env.PLEX_KNOWLEDGE_DIR) o.knowledgeDir = env.PLEX_KNOWLEDGE_DIR;
  if (env.PLEX_AUTO_COMMENT) o.autoComment = /^(1|true|yes)$/i.test(env.PLEX_AUTO_COMMENT);
  if (env.PLEX_AUTO_COMMENT_SKIP_NITS) o.autoCommentSkipNits = /^(1|true|yes)$/i.test(env.PLEX_AUTO_COMMENT_SKIP_NITS);
  if (env.PLEX_EMBEDDING_PROVIDER) {
    o.embedding = { ...(o.embedding ?? {}), provider: env.PLEX_EMBEDDING_PROVIDER as EmbeddingProviderName };
  }
  if (env.PLEX_LLM_PROVIDER || env.PLEX_LLM_MODEL) {
    o.llm = {
      provider: (env.PLEX_LLM_PROVIDER as LlmProviderName) ?? o.llm?.provider ?? 'claude-cli',
      ...(env.PLEX_LLM_MODEL ? { model: env.PLEX_LLM_MODEL } : o.llm?.model ? { model: o.llm.model } : {}),
    };
  }
  const reEnv = numEnv(env.PLEX_SUPPRESSION_REJECT_HALFLIFE_DAYS);
  const waEnv = numEnv(env.PLEX_SUPPRESSION_WAIVE_HALFLIFE_DAYS);
  if (reEnv != null) supp.rejectHalfLifeDays = reEnv;
  if (waEnv != null) supp.waiveHalfLifeDays = waEnv;
  // Only set when a value was actually supplied — a partial fills the rest from defaults via the
  // `resolveConfig` deep-merge; with nothing supplied, leave it unset so defaults (30/365) apply.
  if (supp.rejectHalfLifeDays != null || supp.waiveHalfLifeDays != null) {
    o.suppression = { ...defaultConfig.suppression, ...supp };
  }

  return resolveConfig({ ...o, ...overrides });
}
