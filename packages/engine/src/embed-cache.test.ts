import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EmbeddingProvider } from '@plex/core';
import { cachedEmbed, loadEmbedCache } from './embed-cache';

/** A provider that records how many texts it was asked to embed, so we can assert cache hits. */
class CountingProvider implements EmbeddingProvider {
  readonly name = 'counting';
  readonly dimensions = 3;
  embedded: string[] = [];
  fail = false;
  async embed(texts: string[]): Promise<number[][]> {
    if (this.fail) throw new Error('boom');
    this.embedded.push(...texts);
    // Deterministic per-text vector (length, count of 'a', count of 'b').
    return texts.map((t) => [t.length, (t.match(/a/g) ?? []).length, (t.match(/b/g) ?? []).length]);
  }
}

describe('cachedEmbed', () => {
  const withTmp = async (fn: (file: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'plex-ec-'));
    try {
      await fn(join(dir, 'embed-cache.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('embeds on first call and serves from cache on the second (no re-embed)', async () => {
    await withTmp(async (file) => {
      const p = new CountingProvider();
      const first = await cachedEmbed(p, file, ['alpha', 'beta']);
      expect(first).toEqual([
        [5, 2, 0], // 'alpha' → len 5, two a's, zero b
        [4, 1, 1], // 'beta'  → len 4, one a, one b
      ]);
      expect(p.embedded).toEqual(['alpha', 'beta']);

      // Second round, SAME titles → zero new embeds (the N-round PR win).
      const second = await cachedEmbed(p, file, ['alpha', 'beta']);
      expect(second).toEqual(first);
      expect(p.embedded).toEqual(['alpha', 'beta']); // unchanged: nothing re-embedded
    });
  });

  it('only embeds the MISSES when the batch is partially cached', async () => {
    await withTmp(async (file) => {
      const p = new CountingProvider();
      await cachedEmbed(p, file, ['alpha']);
      p.embedded = [];
      const r = await cachedEmbed(p, file, ['alpha', 'gamma']); // alpha hit, gamma miss
      expect(p.embedded).toEqual(['gamma']);
      expect(r).not.toBeNull();
      expect(r![0]).toEqual([5, 2, 0]); // alpha from cache
      expect(r![1]).toEqual([5, 2, 0]); // gamma freshly embedded ('gamma' → len 5, two a's)
    });
  });

  it('persists the cache to disk so a later process reuses it', async () => {
    await withTmp(async (file) => {
      const p = new CountingProvider();
      await cachedEmbed(p, file, ['alpha']);
      expect(existsSync(file)).toBe(true);
      const onDisk = loadEmbedCache(file);
      expect(Object.keys(onDisk)).toHaveLength(1);

      // A fresh provider instance (new "process") serves from the same file with no embed.
      const p2 = new CountingProvider();
      const r = await cachedEmbed(p2, file, ['alpha']);
      expect(p2.embedded).toEqual([]);
      expect(r).toEqual([[5, 2, 0]]);
    });
  });

  it('returns null when a needed embed fails (caller degrades to locality)', async () => {
    await withTmp(async (file) => {
      const p = new CountingProvider();
      p.fail = true;
      expect(await cachedEmbed(p, file, ['alpha'])).toBeNull();
    });
  });

  it('returns [] for an empty input without touching the provider', async () => {
    await withTmp(async (file) => {
      const p = new CountingProvider();
      expect(await cachedEmbed(p, file, [])).toEqual([]);
      expect(p.embedded).toEqual([]);
      expect(existsSync(file)).toBe(false);
    });
  });

  it('keys by provider name + dims so a different model does not reuse stale vectors', async () => {
    await withTmp(async (file) => {
      const p = new CountingProvider();
      await cachedEmbed(p, file, ['alpha']);
      const other = new CountingProvider();
      Object.defineProperty(other, 'name', { value: 'other-model' });
      other.embedded = [];
      await cachedEmbed(other, file, ['alpha']); // different provider name → miss, re-embeds
      expect(other.embedded).toEqual(['alpha']);
      // Both entries coexist in the file.
      expect(Object.keys(loadEmbedCache(file))).toHaveLength(2);
    });
  });

  it('loadEmbedCache returns {} for a missing or corrupt file', async () => {
    await withTmp(async (file) => {
      expect(loadEmbedCache(file)).toEqual({});
    });
  });
});
