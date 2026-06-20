import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '@plex/core';
import { KnowledgeStore, FakeEmbeddingProvider } from '@plex/knowledge';
import { scanHistory } from './pipeline';
import type { PrRef } from './github';
import type { RawComment } from './types';

// scanHistory is the MECHANICAL half the agent path (`analyze_scan`) rides — no LLM (ADR-51). These
// units cover what the deleted `pipeline.test.ts` exercised via `distillHistory`, plus the oldest-reach
// parity fix the standalone CLI used to provide.

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const store = (): KnowledgeStore => {
  dir = mkdtempSync(join(tmpdir(), 'plex-scan-'));
  return new KnowledgeStore(dir);
};
const substantive = (pr: number, id: string): RawComment => ({
  id,
  prNumber: pr,
  prMerged: true,
  body: 'a real, substantive review comment about validating the tenant id on this query',
});
const config = resolveConfig({ analyze: { maxPrs: 100, clusterThreshold: 0.8, minClusterSize: 1, maxPrsPerRun: 30 } });

describe('scanHistory', () => {
  it('widens the fetch window for order:oldest so it reaches the chronological start (ADR-51 parity)', async () => {
    const maxPrsSeen: number[] = [];
    const fetch = {
      listPrs: async (o: { maxPrs: number }): Promise<PrRef[]> => {
        maxPrsSeen.push(o.maxPrs);
        return [{ number: 1, mergedAt: '2026-01-01' }];
      },
      fetchCommentsForPr: async (): Promise<RawComment[]> => [],
    };
    await scanHistory(store(), new FakeEmbeddingProvider(), config, { cwd: '/x', order: 'oldest', fetch });
    await scanHistory(store(), new FakeEmbeddingProvider(), config, { cwd: '/x', order: 'newest', fetch });
    expect(maxPrsSeen[0]).toBeGreaterThanOrEqual(1000); // oldest widens past the default cap → reaches PR #1
    expect(maxPrsSeen[1]).toBe(100); // newest uses the configured cap
  });

  it('caps fresh PRs at maxPrsPerRun when no explicit --limit (per-run cost guard, ADR-51)', async () => {
    const fetch = {
      listPrs: async (): Promise<PrRef[]> => [1, 2, 3, 4, 5].map((n) => ({ number: n, mergedAt: `2026-01-0${n}` })),
      fetchCommentsForPr: async (_c: string, pr: PrRef): Promise<RawComment[]> => [substantive(pr.number, `c${pr.number}`)],
    };
    const capped = resolveConfig({ analyze: { maxPrs: 100, clusterThreshold: 0.8, minClusterSize: 1, maxPrsPerRun: 2 } });
    // No `limit` passed → the cap bounds it to 2 (oldest-first); re-running would continue at #3.
    const r = await scanHistory(store(), new FakeEmbeddingProvider(), capped, { cwd: '/x', order: 'oldest', fetch });
    expect(r.prsScanned).toBe(2);
    expect(r.scannedPrs).toEqual([1, 2]);
    // An explicit --limit OVERRIDES the cap (the user's deliberate choice).
    const r2 = await scanHistory(store(), new FakeEmbeddingProvider(), capped, { cwd: '/x', order: 'oldest', limit: 4, fetch });
    expect(r2.prsScanned).toBe(4);
  });

  it('limit bounds the fresh PRs this run, oldest-first; the cursor advances', async () => {
    const fetch = {
      listPrs: async (): Promise<PrRef[]> => [1, 2, 3, 4].map((n) => ({ number: n, mergedAt: `2026-01-0${n}` })),
      fetchCommentsForPr: async (_c: string, pr: PrRef): Promise<RawComment[]> => [substantive(pr.number, `c${pr.number}`)],
    };
    const r = await scanHistory(store(), new FakeEmbeddingProvider(), config, { cwd: '/x', order: 'oldest', limit: 2, fetch });
    expect(r.prsScanned).toBe(2);
    expect(r.scannedPrs).toEqual([1, 2]); // the two oldest, bounded by limit
  });

  it('skips already-scanned PRs (incremental) and returns the cumulative cursor', async () => {
    const fetch = {
      listPrs: async (): Promise<PrRef[]> => [1, 2, 3].map((n) => ({ number: n, mergedAt: `2026-01-0${n}` })),
      fetchCommentsForPr: async (_c: string, pr: PrRef): Promise<RawComment[]> => [substantive(pr.number, `c${pr.number}`)],
    };
    const r = await scanHistory(store(), new FakeEmbeddingProvider(), config, { cwd: '/x', order: 'oldest', alreadyScanned: [1, 2], fetch });
    expect(r.prsScanned).toBe(1); // only PR #3 was fresh
    expect(r.scannedPrs).toEqual([1, 2, 3]); // cumulative
  });

  it('denoises (drops trivial comments) and records one incident per substantive comment', async () => {
    const fetch = {
      listPrs: async (): Promise<PrRef[]> => [{ number: 1, mergedAt: '2026-01-01' }],
      fetchCommentsForPr: async (): Promise<RawComment[]> => [
        substantive(1, 's1'),
        { id: 't1', prNumber: 1, prMerged: true, body: 'LGTM' },
        { id: 't2', prNumber: 1, prMerged: true, body: 'nice' },
      ],
    };
    const r = await scanHistory(store(), new FakeEmbeddingProvider(), config, { cwd: '/x', fetch });
    expect(r.comments).toBe(3);
    expect(r.substantive).toBe(1); // LGTM + nice dropped
    expect(r.incidents).toBe(1);
    expect(r.clusters.length).toBe(1);
  });
});
