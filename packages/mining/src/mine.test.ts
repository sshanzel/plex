import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, type CompletionProvider } from '@plex/core';
import { KnowledgeStore, FakeEmbeddingProvider } from '@plex/knowledge';
import { mineHistory } from './mine';
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

// Fake LLM distiller — marks this cluster project-specific (scope: repo), still stored.
const fakeLlm: CompletionProvider = {
  name: 'fake-llm',
  async complete() {
    return '{"title":"Validate tenant id on every query","why":"Queries without a tenant filter leak data.","category":"security","tier":"judgmental","scope":"repo"}';
  },
};

describe('mineHistory (offline, LLM-only)', () => {
  const config = resolveConfig({ mining: { maxPrs: 100, clusterThreshold: 0.4, minClusterSize: 2 } });

  it('denoises, clusters, LLM-distills (scoped), records incidents, tracks scanned PRs', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mine-'));
    const store = new KnowledgeStore(dir);
    const embed = new FakeEmbeddingProvider();

    const { result, scannedPrs } = await mineHistory(store, embed, config, {
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

    const pitfalls = await store.pitfalls();
    expect(pitfalls).toHaveLength(1);
    expect(pitfalls[0]!.scope).toBe('repo'); // project-specific lesson, still stored
    expect(pitfalls[0]!.repo).toBe('r');
    expect(pitfalls[0]!.incidentIds.length).toBeGreaterThanOrEqual(2);

    // Incremental: both PRs scanned ⇒ nothing new.
    const second = await mineHistory(store, embed, config, { cwd: '.', repoName: 'r', alreadyScanned: scannedPrs, fetch: fakeFetch, llm: fakeLlm });
    expect(second.result.prsScanned).toBe(0);
    expect(second.result.pitfalls).toBe(0);
  });

  it('requires an LLM distiller (no silent heuristic)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mine2-'));
    const store = new KnowledgeStore(dir);
    const embed = new FakeEmbeddingProvider();
    // provider 'anthropic' with no key ⇒ createCompletionProvider returns null ⇒ throws.
    const cfg = resolveConfig({ llm: { provider: 'anthropic', apiKeyEnv: 'PLEX_NONEXISTENT_KEY' }, mining: { maxPrs: 100, clusterThreshold: 0.4, minClusterSize: 2 } });
    await expect(mineHistory(store, embed, cfg, { cwd: '.', repoName: 'r', fetch: fakeFetch })).rejects.toThrow(/requires an LLM distiller/);
  });
});
