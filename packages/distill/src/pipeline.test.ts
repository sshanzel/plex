import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, type CompletionProvider } from '@plex/core';
import { KnowledgeStore, FakeEmbeddingProvider } from '@plex/knowledge';
import { distillHistory } from './pipeline';
import type { PrRef } from './github';
import type { RawComment } from './types';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const comment = (prNumber: number, id: string, body: string): RawComment => ({ id, prNumber, prMerged: true, body });

const fakeFetch = {
  listPrs: async (): Promise<PrRef[]> => [
    { number: 1, mergedAt: '2026-01-01' },
    { number: 2, mergedAt: '2026-01-02' },
  ],
  fetchCommentsForPr: async (_cwd: string, pr: PrRef): Promise<RawComment[]> =>
    pr.number === 1
      ? [
          comment(1, '11', 'Validate the tenant id on this database query or it leaks data across tenants'),
          comment(1, '12', 'Missing tenant id validation on the query here, add the tenant filter'),
        ]
      : [
          comment(2, '21', 'This query needs a tenant id filter and validation to avoid cross tenant leaks'),
          comment(2, '22', 'LGTM'),
          comment(2, '23', 'nice'),
        ],
};

const fakeLlm: CompletionProvider = {
  name: 'fake-llm',
  async complete() {
    return '{"title":"Validate tenant id on every query","why":"Queries without a tenant filter leak data.","category":"security","tier":"judgmental","scope":"repo"}';
  },
};

describe('distillHistory (offline, LLM-only)', () => {
  const config = resolveConfig({ analyze: { maxPrs: 100, clusterThreshold: 0.4, minClusterSize: 2 } });

  it('denoises, clusters, LLM-distills (scoped), records incidents, tracks scanned PRs', async () => {
    dir = mkdtempSync(join(tmpdir(), 'distill-'));
    const store = new KnowledgeStore(dir);
    const embed = new FakeEmbeddingProvider();

    const { result, scannedPrs } = await distillHistory(store, embed, config, {
      cwd: '.',
      repoName: 'r',
      fetch: fakeFetch,
      llm: fakeLlm,
    });

    expect(result.comments).toBe(5);
    expect(result.substantive).toBe(3); // LGTM + nice dropped
    expect(result.incidents).toBe(3);
    expect(result.pitfalls).toBe(1);
    expect(result.distiller).toBe('fake-llm');
    expect(scannedPrs).toEqual([1, 2]);
    // The payoff summary: WHAT was learned (title + provenance), for a tangible cold-start report.
    expect(result.learned).toHaveLength(1);
    expect(result.learned[0]).toMatchObject({ title: 'Validate tenant id on every query', action: 'minted', incidents: 3, scope: 'repo' });

    const pitfalls = await store.pitfalls();
    expect(pitfalls).toHaveLength(1);
    expect(pitfalls[0]!.scope).toBe('repo'); // project-specific lesson, still stored
    expect(pitfalls[0]!.repo).toBe('r');
    expect(pitfalls[0]!.incidentIds.length).toBeGreaterThanOrEqual(2);

    // Incremental: both PRs scanned ⇒ nothing new.
    const second = await distillHistory(store, embed, config, { cwd: '.', repoName: 'r', alreadyScanned: scannedPrs, fetch: fakeFetch, llm: fakeLlm });
    expect(second.result.prsScanned).toBe(0);
    expect(second.result.pitfalls).toBe(0);
  });

  it('reinforces a recurring lesson instead of minting duplicates (the 322-pitfall regression)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'distill-dedup-'));
    const store = new KnowledgeStore(dir);
    const embed = new FakeEmbeddingProvider();
    // minClusterSize 1 + a high threshold ⇒ each of the 3 substantive tenant-id comments is its OWN
    // cluster, so the same lesson is distilled three times across the run. Pre-fix this minted (or
    // silently skipped) duplicates; now the first mints and the recurrences REINFORCE the one pitfall.
    const cfg = resolveConfig({ analyze: { maxPrs: 100, clusterThreshold: 0.99, minClusterSize: 1 } });

    const { result } = await distillHistory(store, embed, cfg, { cwd: '.', repoName: 'r', fetch: fakeFetch, llm: fakeLlm });

    expect(result.clusters).toBe(3);
    expect(result.pitfalls).toBe(1); // ONE principle minted
    expect(result.reinforced).toBe(2); // the two recurrences reinforced it, not duplicated
    const pitfalls = await store.pitfalls();
    expect(pitfalls).toHaveLength(1);
    expect(pitfalls[0]!.incidentIds.length).toBe(3); // all three sightings' provenance unioned
  });

  it('reports the lesson anchored to the distinct files its comments concern', async () => {
    dir = mkdtempSync(join(tmpdir(), 'distill-files-'));
    const store = new KnowledgeStore(dir);
    const embed = new FakeEmbeddingProvider();
    // Three tenant-id comments (one cluster) across TWO distinct files (one repeated) → files: 2.
    const withPaths = {
      listPrs: async (): Promise<PrRef[]> => [{ number: 1, mergedAt: '2026-01-01' }],
      fetchCommentsForPr: async (): Promise<RawComment[]> => [
        { id: 'a', prNumber: 1, prMerged: true, body: 'Validate the tenant id on this database query or it leaks across tenants', path: 'src/db.ts' },
        { id: 'b', prNumber: 1, prMerged: true, body: 'Missing tenant id validation on the query here, add the tenant filter', path: 'src/db.ts' },
        { id: 'c', prNumber: 1, prMerged: true, body: 'This query needs a tenant id filter and validation to avoid cross tenant leaks', path: 'src/api.ts' },
      ],
    };
    const { result } = await distillHistory(store, embed, config, { cwd: '.', repoName: 'r', fetch: withPaths, llm: fakeLlm });
    expect(result.learned).toHaveLength(1);
    expect(result.learned[0]!.files).toBe(2); // src/db.ts + src/api.ts, deduped
    expect(result.learned[0]!.incidents).toBe(3);
  });

  it('scans by order + limit and advances the cursor (chronological analysis)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'distill-ord-'));
    const store = new KnowledgeStore(dir);
    const embed = new FakeEmbeddingProvider();
    // gh returns newest-first; analysis sorts per `order`.
    const threePrs = {
      listPrs: async (): Promise<PrRef[]> => [
        { number: 3, mergedAt: '2026-01-03' },
        { number: 2, mergedAt: '2026-01-02' },
        { number: 1, mergedAt: '2026-01-01' },
      ],
      fetchCommentsForPr: async (_cwd: string, pr: PrRef): Promise<RawComment[]> => [comment(pr.number, `${pr.number}1`, 'x')],
    };
    const run = (o: { order?: 'newest' | 'oldest'; limit?: number; alreadyScanned?: number[] }) =>
      distillHistory(store, embed, config, { cwd: '.', repoName: 'r', fetch: threePrs, llm: fakeLlm, ...o });

    expect((await run({ order: 'oldest', limit: 2 })).scannedPrs).toEqual([1, 2]); // chronological first 2
    expect((await run({ limit: 2 })).scannedPrs).toEqual([2, 3]); // newest-first (default), sorted for storage
    const next = await run({ order: 'oldest', limit: 2, alreadyScanned: [1, 2] });
    expect(next.result.prsScanned).toBe(1); // only PR 3 left
    expect(next.scannedPrs).toEqual([1, 2, 3]); // cursor advances
  });

  it('requires an LLM distiller (no silent heuristic)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'distill2-'));
    const store = new KnowledgeStore(dir);
    const embed = new FakeEmbeddingProvider();
    // provider 'anthropic' with no key ⇒ createCompletionProvider returns null ⇒ throws.
    const cfg = resolveConfig({ llm: { provider: 'anthropic', apiKeyEnv: 'PLEX_NONEXISTENT_KEY' }, analyze: { maxPrs: 100, clusterThreshold: 0.4, minClusterSize: 2 } });
    await expect(distillHistory(store, embed, cfg, { cwd: '.', repoName: 'r', fetch: fakeFetch })).rejects.toThrow(/requires an LLM distiller/);
  });
});
