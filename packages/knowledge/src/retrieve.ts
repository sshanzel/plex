import { cosineSimilarity, type EmbeddingProvider, type Pitfall } from '@plex/core';
import type { KnowledgeStore } from './store';

export interface RetrievedPitfall {
  pitfall: Pitfall;
  score: number;
}

/**
 * Retrieve the pitfalls most relevant to a query (the diff's changed symbols, files, and
 * deterministic findings), ranked by embedding cosine similarity (ADR-01: grounded
 * retrieval, not fine-tuning).
 *
 * Scope (ADR-21): global pitfalls always apply; repo-scoped pitfalls apply only when
 * reviewing their origin `repo`, so project-specific knowledge helps within that project
 * without polluting others.
 */
export async function retrieveRelevant(
  store: KnowledgeStore,
  provider: EmbeddingProvider,
  queryText: string,
  topK = 5,
  minScore = 0.05,
  repo?: string,
): Promise<RetrievedPitfall[]> {
  const pitfalls = (await store.pitfalls()).filter(
    (p) => p.embedding && p.embedding.length > 0 && ((p.scope ?? 'global') !== 'repo' || p.repo === repo),
  );
  if (pitfalls.length === 0 || queryText.trim() === '') return [];
  const [q] = await provider.embed([queryText]);
  if (!q) return [];
  return pitfalls
    .map((pitfall) => ({ pitfall, score: cosineSimilarity(q, pitfall.embedding!) }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
