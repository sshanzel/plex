import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pitfall } from '@plex/core';
import { KnowledgeStore } from './store';
import { consolidatePitfalls } from './promotion';

function pf(over: Partial<Pitfall>): Pitfall {
  return {
    id: 'p',
    title: 't',
    trigger: 't',
    why: 't',
    category: 'c',
    tier: 'judgmental',
    confidence: 0.4,
    incidentIds: [],
    ...over,
  };
}

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('consolidatePitfalls', () => {
  it('sets confidence to the Beta posterior mean from accepted/rejected incidents', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-'));
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pf({ id: 'p1', confidence: 0.4 }));
    await store.addPitfall(pf({ id: 'p2', confidence: 0.5 }));
    await store.addIncident({ id: 'i1', pitfallId: 'p1', source: 'review', outcome: 'accepted', ts: 't' });
    await store.addIncident({ id: 'i2', pitfallId: 'p1', source: 'review', outcome: 'accepted', ts: 't' });
    await store.addIncident({ id: 'i3', pitfallId: 'p2', source: 'review', outcome: 'rejected', ts: 't' });

    const res = await consolidatePitfalls(store);
    expect(res.reinforced).toBe(2);
    const byId = Object.fromEntries((await store.pitfalls()).map((p) => [p.id, p]));
    expect(byId['p1']!.confidence).toBeCloseTo(0.75, 5); // Beta(1+2, 1+0) mean = 3/4
    expect(byId['p2']!.confidence).toBeCloseTo(1 / 3.5, 5); // Beta(1, 1+1.5·1) mean = 1/3.5 (reject cost 1.5)
    expect(byId['p1']!.incidentIds).toEqual(['i1', 'i2']);
  });

  it('weights reverted incidents above plain accepts (ADR-11 outcomeWeight)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-rev-'));
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pf({ id: 'pa', title: 'a', confidence: 0.4 }));
    await store.addPitfall(pf({ id: 'pr', title: 'r', confidence: 0.4 }));
    await store.addIncident({ id: 'i1', pitfallId: 'pa', source: 'review', outcome: 'accepted', ts: 't' });
    await store.addIncident({ id: 'i2', pitfallId: 'pr', source: 'review', outcome: 'reverted', ts: 't' });

    await consolidatePitfalls(store);
    const byId = Object.fromEntries((await store.pitfalls()).map((p) => [p.id, p]));
    expect(byId['pa']!.confidence).toBeCloseTo(2 / 3, 5); // Beta(1+1, 1) mean
    expect(byId['pr']!.confidence).toBeCloseTo(2.5 / 3.5, 5); // Beta(1+1.5, 1) mean — stronger
    expect(byId['pr']!.confidence).toBeGreaterThan(byId['pa']!.confidence);
  });

  it('a pitfall with no incidents keeps its prior confidence', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-prior-'));
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pf({ id: 'p1', confidence: 0.83 }));
    const res = await consolidatePitfalls(store);
    expect(res.reinforced).toBe(0);
    expect((await store.pitfalls())[0]!.confidence).toBe(0.83);
  });

  it('is idempotent — re-running with the same incidents leaves confidence put (the Beta fix)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-idem-'));
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pf({ id: 'p1', confidence: 0.4 }));
    await store.addIncident({ id: 'i1', pitfallId: 'p1', source: 'review', outcome: 'accepted', ts: 't' });
    await store.addIncident({ id: 'i2', pitfallId: 'p1', source: 'review', outcome: 'accepted', ts: 't' });

    await consolidatePitfalls(store);
    const after1 = (await store.pitfalls())[0]!.confidence;
    expect(after1).toBeCloseTo(0.75, 5);

    await consolidatePitfalls(store); // SAME incidents — the old additive rule drifted 0.6→0.8→…
    expect((await store.pitfalls())[0]!.confidence).toBeCloseTo(after1, 10); // exactly unchanged

    await store.addIncident({ id: 'i3', pitfallId: 'p1', source: 'review', outcome: 'rejected', ts: 't' });
    await consolidatePitfalls(store); // one NEW reject moves it, exactly once
    expect((await store.pitfalls())[0]!.confidence).toBeCloseTo(3 / 5.5, 5); // Beta(1+2, 1+1.5)
    expect((await store.pitfalls())[0]!.incidentIds).toEqual(['i1', 'i2', 'i3']);
  });
});
