import { describe, it, expect } from 'vitest';
import { cosineSimilarity, slugify, hashId, safeEmbed, type EmbeddingProvider } from './providers';

// safeEmbed wraps a provider so a transient failure degrades a feature instead of throwing, and an
// oversized batch is capped + chunked under provider array/token limits (m5 + B-G1).
describe('safeEmbed', () => {
  const stub = (over: Partial<EmbeddingProvider> = {}): EmbeddingProvider => ({
    name: 'stub',
    dimensions: 1,
    embed: async (texts) => texts.map((t) => [t.length]),
    ...over,
  });

  it('passes vectors through on success, aligned to inputs', async () => {
    expect(await safeEmbed(stub(), ['a', 'bb'])).toEqual([[1], [2]]);
  });

  it('returns null instead of throwing when the provider fails', async () => {
    const throwing = stub({ embed: async () => { throw new Error('rate limited'); } });
    expect(await safeEmbed(throwing, ['a'])).toBeNull();
  });

  it('chunks large batches but keeps result order aligned to inputs', async () => {
    const batchSizes: number[] = [];
    const p = stub({ embed: async (texts) => { batchSizes.push(texts.length); return texts.map((t) => [t.length]); } });
    const inputs = Array.from({ length: 300 }, (_, i) => 'x'.repeat(i % 7));
    const out = await safeEmbed(p, inputs, { chunkSize: 128 });
    expect(out!.length).toBe(300);
    expect(out!.map((v) => v[0])).toEqual(inputs.map((t) => t.length)); // order preserved across chunk boundaries
    expect(batchSizes).toEqual([128, 128, 44]); // never one 300-item request
  });

  it('caps each text to maxChars before sending it to the provider', async () => {
    let sent: string[] = [];
    const p = stub({ embed: async (texts) => { sent = texts; return texts.map(() => [0]); } });
    await safeEmbed(p, ['a'.repeat(10000)], { maxChars: 100 });
    expect(sent[0]!.length).toBe(100);
  });

  it('returns null if ANY chunk fails (all-or-nothing keeps caller index alignment safe)', async () => {
    let call = 0;
    const p = stub({ embed: async (texts) => { if (++call === 2) throw new Error('boom'); return texts.map(() => [0]); } });
    expect(await safeEmbed(p, Array.from({ length: 200 }, () => 'x'), { chunkSize: 128 })).toBeNull();
  });
});

// slugify + hashId build collision-free ids for pitfalls/incidents. The hash is what
// rescues distinct-but-same-slug (or empty-slug) titles from colliding.
describe('slugify', () => {
  it('lowercases, collapses non-alphanumerics to dashes, trims, and caps length', () => {
    expect(slugify('Always validate Tenant ID!')).toBe('always-validate-tenant-id');
    expect(slugify('  --weird__name--  ')).toBe('weird-name');
    expect(slugify('a'.repeat(80))).toHaveLength(48);
    expect(slugify('a'.repeat(80), 56)).toHaveLength(56);
  });
  it('returns empty string for non-ASCII / symbol-only text', () => {
    expect(slugify('🚀🚀🚀')).toBe('');
    expect(slugify('验证租户')).toBe('');
  });
});

describe('hashId', () => {
  it('is stable for the same input and distinct for different inputs', () => {
    expect(hashId('Fix the bug!')).toBe(hashId('Fix the bug!'));
    expect(hashId('Fix the bug!')).not.toBe(hashId('Fix the bug?')); // punctuation-only diff
    expect(hashId('🚀')).not.toBe(hashId('💯')); // distinct even when both slugify to ''
    expect(hashId('x')).toMatch(/^[0-9a-f]{8}$/);
  });
});

// cosineSimilarity is the backbone of EVERY semantic feature — knowledge retrieval,
// mining clusters, semantic waivers (≥0.82), and round attribution. Pin its contract.
describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('is invariant to magnitude (direction only)', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([0.1, 0.2], [10, 20])).toBeCloseTo(1, 10);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 10);
  });

  it('returns 0 (not NaN) when either vector is all-zero', () => {
    // The semantic-waiver guard depends on this: a zero embedding must NOT spuriously match.
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('compares only the overlapping prefix when lengths differ (no crash, no NaN)', () => {
    // Defensive: mismatched dims (e.g. swapping embedding providers) must degrade, not throw.
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBeCloseTo(1, 10); // 3rd dim ignored
    expect(cosineSimilarity([], [1, 2, 3])).toBe(0); // empty → 0, not NaN
  });

  it('lands a partial-overlap similarity strictly between 0 and 1', () => {
    const s = cosineSimilarity([1, 1, 0], [1, 0, 0]);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
    expect(s).toBeCloseTo(1 / Math.SQRT2, 10);
  });
});
