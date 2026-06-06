import type { EmbeddingProvider, EmbeddingConfig } from '@plex/core';

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}
function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic bag-of-words embedding for tests / offline use (ADR-13). Shared tokens
 * ⇒ higher cosine similarity, which is all retrieval needs to be exercised without a
 * network call or API key.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake';
  readonly dimensions: number;
  constructor(dimensions = 64) {
    this.dimensions = dimensions;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vec(t));
  }
  private vec(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const tok of tokenize(text)) v[fnv1a(tok) % this.dimensions] += 1;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`embedding request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** OpenAI `text-embedding-3-*`. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions = 1536;
  constructor(private model: string, private apiKey: string, private baseUrl = 'https://api.openai.com') {}
  async embed(texts: string[]): Promise<number[][]> {
    const data = await postJson(`${this.baseUrl}/v1/embeddings`, { model: this.model, input: texts }, { authorization: `Bearer ${this.apiKey}` });
    return data.data.map((d: { embedding: number[] }) => d.embedding);
  }
}

/** Voyage `voyage-code-3` (code-specialized — Anthropic's recommended embeddings). */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly dimensions = 1024;
  constructor(private model: string, private apiKey: string, private baseUrl = 'https://api.voyageai.com') {}
  async embed(texts: string[]): Promise<number[][]> {
    const data = await postJson(`${this.baseUrl}/v1/embeddings`, { model: this.model, input: texts }, { authorization: `Bearer ${this.apiKey}` });
    return data.data.map((d: { embedding: number[] }) => d.embedding);
  }
}

/** Local Ollama (e.g. `nomic-embed-text`) — fully local, private. */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly dimensions = 768;
  constructor(private model: string, private baseUrl = 'http://localhost:11434') {}
  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const prompt of texts) {
      const data = await postJson(`${this.baseUrl}/api/embeddings`, { model: this.model, prompt }, {});
      out.push(data.embedding);
    }
    return out;
  }
}

/** Construct the configured provider. Defaults to the deterministic fake. */
export function createEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider {
  switch (cfg.provider) {
    case 'openai': {
      const key = process.env[cfg.apiKeyEnv ?? 'OPENAI_API_KEY'];
      if (!key) throw new Error(`OpenAI embeddings need ${cfg.apiKeyEnv ?? 'OPENAI_API_KEY'}`);
      return new OpenAIEmbeddingProvider(cfg.model ?? 'text-embedding-3-small', key, cfg.baseUrl);
    }
    case 'voyage': {
      const key = process.env[cfg.apiKeyEnv ?? 'VOYAGE_API_KEY'];
      if (!key) throw new Error(`Voyage embeddings need ${cfg.apiKeyEnv ?? 'VOYAGE_API_KEY'}`);
      return new VoyageEmbeddingProvider(cfg.model ?? 'voyage-code-3', key, cfg.baseUrl);
    }
    case 'ollama':
      return new OllamaEmbeddingProvider(cfg.model ?? 'nomic-embed-text', cfg.baseUrl);
    case 'fake':
    default:
      return new FakeEmbeddingProvider();
  }
}
