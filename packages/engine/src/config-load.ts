import {
  resolveConfig,
  type ReviewerConfig,
  type EmbeddingProviderName,
  type LlmProviderName,
} from '@plex/core';

/**
 * Build a config from environment variables over the local-first defaults. Only
 * defined env vars override, so defaults are preserved.
 *
 *   PLEX_DATA_DIR             where per-repo data lives (default `.plex`)
 *   PLEX_KNOWLEDGE_DIR        global knowledge base dir (default ~/.plex/knowledge)
 *   PLEX_FALKORDB_URL         enables the ephemeral layer, e.g. redis://localhost:6380
 *   PLEX_EMBEDDING_PROVIDER   voyage | openai | gemini | ollama | none (default none)
 *   PLEX_LLM_PROVIDER         mining distiller: claude-cli | anthropic | openai
 *   PLEX_LLM_MODEL            model id for the mining distiller
 */
export function loadConfig(overrides: Partial<ReviewerConfig> = {}): ReviewerConfig {
  const env = process.env;
  const o: Partial<ReviewerConfig> = {};
  if (env.PLEX_DATA_DIR) o.dataDir = env.PLEX_DATA_DIR;
  if (env.PLEX_KNOWLEDGE_DIR) o.knowledgeDir = env.PLEX_KNOWLEDGE_DIR;
  if (env.PLEX_FALKORDB_URL) o.falkordb = { enabled: true, url: env.PLEX_FALKORDB_URL };
  if (env.PLEX_EMBEDDING_PROVIDER) {
    o.embedding = { provider: env.PLEX_EMBEDDING_PROVIDER as EmbeddingProviderName };
  }
  if (env.PLEX_LLM_PROVIDER || env.PLEX_LLM_MODEL) {
    o.llm = {
      provider: (env.PLEX_LLM_PROVIDER as LlmProviderName) ?? 'heuristic',
      ...(env.PLEX_LLM_MODEL ? { model: env.PLEX_LLM_MODEL } : {}),
    };
  }
  return resolveConfig({ ...o, ...overrides });
}
