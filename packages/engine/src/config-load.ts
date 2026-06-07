import {
  resolveConfig,
  type ReviewerConfig,
  type EmbeddingProviderName,
  type LlmProviderName,
} from '@plex/core';
import { readHomeConfig } from './home-config';

/**
 * Build a config from, in increasing precedence: defaults < `~/.plex/config.json` (written
 * by `plex init`) < environment variables < explicit overrides. The home config lets a user
 * set their FalkorDB URL + embedding key once; env still wins for per-invocation overrides.
 *
 *   PLEX_DATA_DIR             per-repo data dir ('' = centralized ~/.plex/repos/<id>)
 *   PLEX_KNOWLEDGE_DIR        global knowledge base dir (default ~/.plex/knowledge)
 *   PLEX_EMBEDDING_PROVIDER   voyage | openai | gemini | ollama | none (default none)
 *   PLEX_LLM_PROVIDER         mining distiller: claude-cli | anthropic | openai
 *   PLEX_LLM_MODEL            model id for the mining distiller
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

  // --- environment (overrides home) ---
  if (env.PLEX_DATA_DIR) o.dataDir = env.PLEX_DATA_DIR;
  if (env.PLEX_KNOWLEDGE_DIR) o.knowledgeDir = env.PLEX_KNOWLEDGE_DIR;
  if (env.PLEX_EMBEDDING_PROVIDER) {
    o.embedding = { ...(o.embedding ?? {}), provider: env.PLEX_EMBEDDING_PROVIDER as EmbeddingProviderName };
  }
  if (env.PLEX_LLM_PROVIDER || env.PLEX_LLM_MODEL) {
    o.llm = {
      provider: (env.PLEX_LLM_PROVIDER as LlmProviderName) ?? o.llm?.provider ?? 'claude-cli',
      ...(env.PLEX_LLM_MODEL ? { model: env.PLEX_LLM_MODEL } : o.llm?.model ? { model: o.llm.model } : {}),
    };
  }

  return resolveConfig({ ...o, ...overrides });
}
