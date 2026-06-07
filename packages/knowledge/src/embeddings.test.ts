import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EmbeddingConfig } from '@plex/core';
import { createEmbeddingProvider, FakeEmbeddingProvider } from './embeddings';

// createEmbeddingProvider gates EVERY semantic feature on/off. Its key resolution
// (env var vs ~/.plex apiKey vs apiKeyEnv override) is non-obvious — a missing key must
// yield null (features disabled), never a half-built client. Was entirely untested.
const KEYS = ['VOYAGE_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'CUSTOM_KEY'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const cfg = (over: Partial<EmbeddingConfig>): EmbeddingConfig => ({ provider: 'none', ...over });

describe('createEmbeddingProvider — provider/key resolution', () => {
  it('returns null for `none`, unknown, and a keyless paid provider', () => {
    expect(createEmbeddingProvider(cfg({ provider: 'none' }))).toBeNull();
    expect(createEmbeddingProvider(cfg({ provider: 'voyage' }))).toBeNull(); // no key anywhere
    expect(createEmbeddingProvider(cfg({ provider: 'openai' }))).toBeNull();
  });

  it('uses an env key when present', () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    expect(createEmbeddingProvider(cfg({ provider: 'openai' }))?.name).toBe('openai');
  });

  it('falls back to the config apiKey (~/.plex) when no env key', () => {
    expect(createEmbeddingProvider(cfg({ provider: 'voyage', apiKey: 'k' }))?.name).toBe('voyage');
  });

  it('honors apiKeyEnv override — and does NOT consult the default env var', () => {
    // apiKeyEnv:'CUSTOM_KEY' present → used.
    process.env.CUSTOM_KEY = 'sk-custom';
    expect(createEmbeddingProvider(cfg({ provider: 'openai', apiKeyEnv: 'CUSTOM_KEY' }))?.name).toBe('openai');
    // apiKeyEnv set but UNSET, while OPENAI_API_KEY IS set and no apiKey → still null
    // (the override short-circuits the standard var). This is the subtle bit.
    delete process.env.CUSTOM_KEY;
    process.env.OPENAI_API_KEY = 'sk-env';
    expect(createEmbeddingProvider(cfg({ provider: 'openai', apiKeyEnv: 'CUSTOM_KEY' }))).toBeNull();
    // ...but a config apiKey still rescues it.
    expect(createEmbeddingProvider(cfg({ provider: 'openai', apiKeyEnv: 'CUSTOM_KEY', apiKey: 'k' }))?.name).toBe('openai');
  });

  it('ollama needs no key (never null); fake is the test-only embedder', () => {
    expect(createEmbeddingProvider(cfg({ provider: 'ollama' }))?.name).toBe('ollama');
    expect(createEmbeddingProvider(cfg({ provider: 'fake' }))?.name).toBe('fake');
  });
});

describe('FakeEmbeddingProvider.vec normalization', () => {
  it('returns an all-zero vector (length = dims, no NaN) for token-less text', async () => {
    const [v] = await new FakeEmbeddingProvider(64).embed(['']);
    expect(v).toHaveLength(64);
    expect(v!.every((x) => x === 0)).toBe(true); // norm `|| 1` guard avoids NaN
  });

  it('produces an L2-normalized vector for real text', async () => {
    const [v] = await new FakeEmbeddingProvider().embed(['null deref on user']);
    const mag = Math.sqrt(v!.reduce((s, x) => s + x * x, 0));
    expect(mag).toBeCloseTo(1, 6);
  });

  it('is deterministic — identical text yields identical vectors', async () => {
    const e = new FakeEmbeddingProvider();
    const [a, b] = await e.embed(['same text here', 'same text here']);
    expect(a).toEqual(b);
  });
});
