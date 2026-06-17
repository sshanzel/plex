import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pitfall, Incident, IncidentOutcome } from '@plex/core';
import { KnowledgeStore } from './store';
import { addOrReinforcePitfall } from './reinforce';

const pf = (over: Partial<Pitfall> & { id: string; title: string }): Pitfall => ({
  trigger: over.title,
  why: '',
  category: 'general',
  tier: 'judgmental',
  confidence: 0,
  incidentIds: [],
  ...over,
});

const inc = (id: string, outcome?: IncidentOutcome, ts = '2026-01-01T00:00:00Z'): Incident => ({
  id,
  source: 'analyzed',
  ts,
  outcome,
});

describe('addOrReinforcePitfall', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const freshStore = (): KnowledgeStore => {
    dir = mkdtempSync(join(tmpdir(), 'kn-reinforce-'));
    return new KnowledgeStore(dir);
  };

  it('mints when the store is empty', async () => {
    const store = freshStore();
    const res = await addOrReinforcePitfall(store, pf({ id: 'a', title: 'Validate the tenant id', embedding: [1, 0, 0] }));
    expect(res.action).toBe('minted');
    expect((await store.pitfalls()).length).toBe(1);
  });

  it('reinforces a semantically-matching pitfall instead of minting a duplicate', async () => {
    const store = freshStore();
    await store.addIncident(inc('i1'));
    await store.addPitfall(pf({ id: 'a', title: 'Validate the tenant id filter', embedding: [1, 0, 0], incidentIds: ['i1'] }));
    await store.addIncident(inc('i2', 'fixed', '2026-02-01T00:00:00Z'));

    const res = await addOrReinforcePitfall(
      store,
      pf({ id: 'b', title: 'Check the tenant id on the query', embedding: [0.98, 0.02, 0], incidentIds: ['i2'] }),
    );

    expect(res.action).toBe('reinforced');
    expect(res.pitfallId).toBe('a'); // the established principle, not the new candidate id
    // The result reports the CANONICAL stored shape (for the cold-start payoff), not the candidate:
    // the established title and the UNIONED incident count — never the new sighting's title/size.
    expect(res.title).toBe('Validate the tenant id filter');
    expect(res.incidents).toBe(2); // union of i1 + i2, not the candidate's lone i2
    const pitfalls = await store.pitfalls();
    expect(pitfalls.length).toBe(1); // no duplicate minted
    expect(pitfalls[0]!.incidentIds.sort()).toEqual(['i1', 'i2']); // provenance unioned
    expect(pitfalls[0]!.title).toBe('Validate the tenant id filter'); // matched text preserved
    expect(pitfalls[0]!.lastReinforcedAt).toContain('2026-02-01'); // newest evidence ts
  });

  it('mints a second pitfall when nothing matches semantically', async () => {
    const store = freshStore();
    await store.addPitfall(pf({ id: 'a', title: 'Validate the tenant id', embedding: [1, 0, 0] }));
    const res = await addOrReinforcePitfall(store, pf({ id: 'b', title: 'Prefer const over let', embedding: [0, 1, 0] }));
    expect(res.action).toBe('minted');
    expect((await store.pitfalls()).length).toBe(2);
  });

  it('exact-title fallback reinforces vectorless duplicates (never worse than hasPitfallTitled)', async () => {
    const store = freshStore();
    await store.addPitfall(pf({ id: 'a', title: 'Avoid N+1 queries in list endpoints' })); // no embedding
    const res = await addOrReinforcePitfall(store, pf({ id: 'b', title: 'Avoid N+1 queries in list endpoints' }));
    expect(res.action).toBe('reinforced');
    expect(res.pitfallId).toBe('a');
    expect((await store.pitfalls()).length).toBe(1);
  });

  it('lexical fallback reinforces similar vectorless titles, mints dissimilar ones', async () => {
    const store = freshStore();
    await store.addPitfall(pf({ id: 'a', title: 'Always validate the tenant id filter on database queries' }));

    const similar = await addOrReinforcePitfall(store, pf({ id: 'b', title: 'validate tenant id filter on database queries' }));
    expect(similar.action).toBe('reinforced');

    const dissimilar = await addOrReinforcePitfall(store, pf({ id: 'c', title: 'Prefer dependency injection for testability' }));
    expect(dissimilar.action).toBe('minted');
  });

  it('a vectored candidate still falls through to lexical against an all-vectorless store', async () => {
    // Mixed-embedding transitional case: the candidate has a vector but the only eligible pitfall is
    // legacy/vectorless, so there is nothing to compare cosines against. It must NOT collapse to
    // exact-title-only — lexical should catch the rephrased recurrence (mirrors inferPitfallId).
    const store = freshStore();
    await store.addPitfall(pf({ id: 'a', title: 'Always validate the tenant id filter on database queries' })); // no embedding
    const res = await addOrReinforcePitfall(
      store,
      pf({ id: 'b', title: 'validate the tenant id filter on db queries', embedding: [1, 0, 0] }),
    );
    expect(res.action).toBe('reinforced');
    expect(res.pitfallId).toBe('a');
    expect((await store.pitfalls()).length).toBe(1);
  });

  it('never merges a positive candidate into a negative (suppression) pitfall', async () => {
    const store = freshStore();
    await store.addPitfall(pf({ id: 'n', title: 'Suppress: this lint is intentional', embedding: [1, 0, 0], polarity: 'negative' }));
    const res = await addOrReinforcePitfall(store, pf({ id: 'p', title: 'Real issue here', embedding: [1, 0, 0], polarity: 'positive' }));
    expect(res.action).toBe('minted'); // polarity guard: high cosine but opposite polarity
    expect((await store.pitfalls()).length).toBe(2);
  });

  it('respects repo scope: matches a global pitfall but not another repo’s', async () => {
    const store = freshStore();
    await store.addPitfall(pf({ id: 'b', title: 'Lesson from repo B', embedding: [1, 0, 0], scope: 'repo', repo: 'B' }));
    const crossRepo = await addOrReinforcePitfall(store, pf({ id: 'a', title: 'Lesson', embedding: [1, 0, 0], scope: 'repo', repo: 'A' }));
    expect(crossRepo.action).toBe('minted'); // repo A must not reinforce repo B's lesson

    await store.addPitfall(pf({ id: 'g', title: 'Global lesson', embedding: [0, 1, 0], scope: 'global' }));
    const toGlobal = await addOrReinforcePitfall(store, pf({ id: 'a2', title: 'Another phrasing', embedding: [0, 1, 0], scope: 'repo', repo: 'A' }));
    expect(toGlobal.action).toBe('reinforced'); // a global pitfall is in scope for any repo
    expect(toGlobal.pitfallId).toBe('g');
  });

  it('confidence climbs with each confirming recurrence (Wilson tightening)', async () => {
    const store = freshStore();
    await store.addIncident(inc('i1')); // abstain
    await store.addPitfall(pf({ id: 'a', title: 'Validate the tenant id', embedding: [1, 0, 0], incidentIds: ['i1'], confidence: 0 }));

    await store.addIncident(inc('i2', 'fixed'));
    await addOrReinforcePitfall(store, pf({ id: 'b', title: 'tenant id check', embedding: [1, 0, 0], incidentIds: ['i2'] }));
    const c1 = (await store.pitfalls())[0]!.confidence;

    await store.addIncident(inc('i3', 'fixed'));
    await addOrReinforcePitfall(store, pf({ id: 'c', title: 'tenant id guard', embedding: [1, 0, 0], incidentIds: ['i3'] }));
    const c2 = (await store.pitfalls())[0]!.confidence;

    expect(c1).toBeGreaterThan(0);
    expect(c2).toBeGreaterThan(c1);
  });

  it('is idempotent: re-reinforcing with the same incident changes nothing', async () => {
    const store = freshStore();
    await store.addIncident(inc('i1'));
    await store.addIncident(inc('i2', 'fixed'));
    await store.addPitfall(pf({ id: 'a', title: 'Validate the tenant id', embedding: [1, 0, 0], incidentIds: ['i1'] }));

    const candidate = pf({ id: 'b', title: 'tenant id check', embedding: [1, 0, 0], incidentIds: ['i2'] });
    await addOrReinforcePitfall(store, candidate);
    const first = (await store.pitfalls())[0]!;

    await addOrReinforcePitfall(store, candidate);
    const second = (await store.pitfalls())[0]!;

    expect(second.incidentIds.sort()).toEqual(first.incidentIds.sort());
    expect(second.confidence).toBe(first.confidence);
    expect((await store.pitfalls()).length).toBe(1);
  });
});
