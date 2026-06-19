import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, type Incident, type Pitfall } from '@plex/core';
import { KnowledgeStore } from '@plex/knowledge';
import type { PrRef, RawComment } from '@plex/distill';
import { refreshAnalyzedOutcomes } from './analyze';

// refreshAnalyzedOutcomes (ADR-50) opens NO Kùzu (JSONL knowledge store + consolidate only), so it's a
// plain vitest unit with an injected fake GitHub. The load-bearing guarantees: only `inc:analyzed:*` are
// touched (live accepts survive), outcomes only ever UPGRADE (idempotent, never downgrade on a fetch
// miss), confidence lifts after consolidate, and an unreachable repo is a safe no-op.

let dir: string;
const recentTs = '2026-06-18T00:00:00.000Z'; // ~now → decay ≈ 1 so confidence visibly lifts

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plex-refresh-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const inc = (id: string, outcome?: Incident['outcome']): Incident =>
  ({ id, source: id.startsWith('inc:analyzed:') ? 'analyzed' : 'review', snippet: id, ts: recentTs, ...(outcome ? { outcome } : {}) } as Incident);

const pf = (id: string, incidentIds: string[]): Pitfall =>
  ({ id, title: id, trigger: id, why: '', category: 'general', tier: 'judgmental', confidence: 0, polarity: 'positive', incidentIds } as Pitfall);

/** Fake GitHub: PR #1 (merged) with c1 (observed change → fixed) and c2 (author reply-agreement → corroborated). */
const fakeFetch = {
  listPrs: async (): Promise<PrRef[]> => [{ number: 1, mergedAt: recentTs }],
  fetchCommentsForPr: async (): Promise<RawComment[]> => [
    { id: 'c1', prNumber: 1, prMerged: true, outdated: true, body: 'tenant filter missing' },
    { id: 'c2', prNumber: 1, prMerged: true, outdated: false, author: 'reviewer', replies: [{ author: 'pr-author', body: 'done, fixed' }], body: 'validate the schema' },
  ],
};

const seed = async (): Promise<KnowledgeStore> => {
  const store = new KnowledgeStore(dir);
  await store.addIncident(inc('inc:analyzed:c1')); // abstain → should become fixed
  await store.addIncident(inc('inc:analyzed:c2')); // abstain → should become corroborated
  await store.addIncident(inc('inc:review:r1', 'accepted')); // live accept — must survive untouched
  await store.addPitfall(pf('pf1', ['inc:analyzed:c1', 'inc:analyzed:c2']));
  return store;
};

describe('refreshAnalyzedOutcomes', () => {
  it('upgrades analyzed outcomes from GitHub and lifts confidence off zero, sparing live accepts', async () => {
    const store = await seed();
    const config = resolveConfig({ knowledgeDir: dir });

    const res = await refreshAnalyzedOutcomes(process.cwd(), config, { fetch: fakeFetch });
    expect(res.repoReachable).toBe(true);
    expect(res.matched).toBe(2);
    expect(res.upgraded).toBe(2);
    expect(res.confirms).toBe(2);

    const byId = new Map((await store.incidents()).map((i) => [i.id, i.outcome]));
    expect(byId.get('inc:analyzed:c1')).toBe('fixed'); // observed code change
    expect(byId.get('inc:analyzed:c2')).toBe('corroborated'); // reply-agreement
    expect(byId.get('inc:review:r1')).toBe('accepted'); // NOT re-derivable — must be preserved

    const conf = (await store.pitfalls()).find((p) => p.id === 'pf1')!.confidence;
    expect(conf).toBeGreaterThan(0); // was 0 (all-abstain); consolidate lifts it once confirms exist
  });

  it('is idempotent — a second run upgrades nothing', async () => {
    const config = resolveConfig({ knowledgeDir: dir });
    await seed();
    await refreshAnalyzedOutcomes(process.cwd(), config, { fetch: fakeFetch });
    const second = await refreshAnalyzedOutcomes(process.cwd(), config, { fetch: fakeFetch });
    expect(second.matched).toBe(2);
    expect(second.upgraded).toBe(0); // already fixed/corroborated; never downgrades, never re-upgrades
  });

  it('never downgrades a prior confirm when a later fetch abstains', async () => {
    const store = new KnowledgeStore(dir);
    await store.addIncident(inc('inc:analyzed:c1', 'fixed')); // already a strong confirm
    const config = resolveConfig({ knowledgeDir: dir });
    const abstaining = {
      listPrs: async (): Promise<PrRef[]> => [{ number: 1, mergedAt: recentTs }],
      fetchCommentsForPr: async (): Promise<RawComment[]> => [{ id: 'c1', prNumber: 1, prMerged: true, outdated: false, body: 'x' }],
    };
    const res = await refreshAnalyzedOutcomes(process.cwd(), config, { fetch: abstaining });
    expect(res.upgraded).toBe(0);
    expect((await store.incidents()).find((i) => i.id === 'inc:analyzed:c1')!.outcome).toBe('fixed');
  });

  it('is a safe no-op when the repo is unreachable (gh throws)', async () => {
    const store = await seed();
    const config = resolveConfig({ knowledgeDir: dir });
    const unreachable = {
      listPrs: async (): Promise<PrRef[]> => {
        throw new Error('gh: could not resolve repository');
      },
      fetchCommentsForPr: async (): Promise<RawComment[]> => [],
    };
    const res = await refreshAnalyzedOutcomes(process.cwd(), config, { fetch: unreachable });
    expect(res.repoReachable).toBe(false);
    expect(res.upgraded).toBe(0);
    // store untouched — analyzed incidents still abstaining, accept preserved
    const byId = new Map((await store.incidents()).map((i) => [i.id, i.outcome]));
    expect(byId.get('inc:analyzed:c1')).toBeUndefined();
    expect(byId.get('inc:review:r1')).toBe('accepted');
  });

  it('reports nothing-to-do when there are no analyzed incidents', async () => {
    const store = new KnowledgeStore(dir);
    await store.addIncident(inc('inc:review:r1', 'accepted'));
    const res = await refreshAnalyzedOutcomes(process.cwd(), resolveConfig({ knowledgeDir: dir }), { fetch: fakeFetch });
    expect(res.analyzedIncidents).toBe(0);
    expect(res.upgraded).toBe(0);
  });
});
