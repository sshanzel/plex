/**
 * Pluggable provider interfaces (ADR-13).
 *
 * Embeddings are intentionally abstracted to a single `text -> vector` function so
 * the implementation (Voyage `voyage-code-3`, OpenAI `text-embedding-3-small`, local
 * Ollama, or a deterministic fake for tests) can be swapped without touching callers.
 *
 * NOTE: generative LLMs (Opus/GPT/Gemini-chat) are NOT embedding models — an embedding
 * provider must wrap an actual embedding endpoint.
 */
import { createHash } from 'node:crypto';

export interface EmbeddingProvider {
  readonly name: string;
  /** Vector dimensionality this provider returns. */
  readonly dimensions: number;
  /** Embed a batch of texts; result[i] corresponds to texts[i]. */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Generative completion, used ONLY by the offline mining/distillation pipeline (ADR-02 —
 * the interactive review uses the connected agent, never this). Implementations: a
 * deterministic heuristic (no network), Anthropic, OpenAI.
 */
export interface CompletionProvider {
  readonly name: string;
  complete(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string>;
}

/** URL/id-safe slug: lowercase, non-alphanumerics → '-', trimmed, capped. */
export function slugify(s: string, maxLen = 48): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen);
}

/**
 * Short, stable content hash for disambiguating ids whose slugs would collide or be
 * empty (e.g. two titles sharing a 48-char prefix, or a non-ASCII/emoji-only title that
 * slugs to ''). Distinct input → distinct suffix; same input → same suffix (idempotent).
 */
export function hashId(s: string, len = 8): string {
  return createHash('sha1').update(s).digest('hex').slice(0, len);
}

/** Cosine similarity helper for retrieval over embedding vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
