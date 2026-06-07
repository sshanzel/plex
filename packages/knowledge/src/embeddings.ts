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

/** Google Gemini embeddings (e.g. `gemini-embedding-001`). */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'gemini';
  readonly dimensions = 3072;
  constructor(private model: string, private apiKey: string, private baseUrl = 'https://generativelanguage.googleapis.com') {}
  async embed(texts: string[]): Promise<number[][]> {
    const body = {
      requests: texts.map((t) => ({ model: `models/${this.model}`, content: { parts: [{ text: t }] } })),
    };
    const data = await postJson(`${this.baseUrl}/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`, body, {});
    return data.embeddings.map((e: { values: number[] }) => e.values);
  }
}

/**
 * Construct the configured embedding provider, or `null` when none is usable (provider
 * `none`, or a missing API key). Real operation requires a real provider; `fake` is a
 * deterministic test-only embedder and is never the default. Callers treat `null` as
 * "knowledge features unavailable" (retrieval returns nothing; writes error).
 */
export function createEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider | null {
  const env = process.env;
  // Prefer an env key; else the key stored in ~/.plex/config.json (ADR-29).
  const keyFor = (envVar: string): string | undefined => env[cfg.apiKeyEnv ?? envVar] ?? cfg.apiKey;
  switch (cfg.provider) {
    case 'voyage': {
      const key = keyFor('VOYAGE_API_KEY');
      return key ? new VoyageEmbeddingProvider(cfg.model ?? 'voyage-code-3', key, cfg.baseUrl) : null;
    }
    case 'openai': {
      const key = keyFor('OPENAI_API_KEY');
      return key ? new OpenAIEmbeddingProvider(cfg.model ?? 'text-embedding-3-small', key, cfg.baseUrl) : null;
    }
    case 'gemini': {
      const key = keyFor('GEMINI_API_KEY');
      return key ? new GeminiEmbeddingProvider(cfg.model ?? 'gemini-embedding-001', key, cfg.baseUrl) : null;
    }
    case 'ollama':
      return new OllamaEmbeddingProvider(cfg.model ?? 'nomic-embed-text', cfg.baseUrl);
    case 'fake':
      return new FakeEmbeddingProvider(); // test-only
    case 'none':
    default:
      return null;
  }
}
