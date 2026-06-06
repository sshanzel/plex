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
export interface EmbeddingProvider {
  readonly name: string;
  /** Vector dimensionality this provider returns. */
  readonly dimensions: number;
  /** Embed a batch of texts; result[i] corresponds to texts[i]. */
  embed(texts: string[]): Promise<number[][]>;
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
