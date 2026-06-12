import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pitfall } from '@plex/core';
import { KnowledgeStore } from './store';
import { consolidatePitfalls } from './promotion';
import { wilsonLowerBound } from './stats';

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
  it('sets confidence to the Wilson lower bound of the confirm rate', async () => {
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
    expect(byId['p1']!.confidence).toBeCloseTo(wilsonLowerBound(2, 2), 10); // 2 confirms / 2 ≈ 0.342
    expect(byId['p2']!.confidence).toBe(0); // 0 confirms / 1 refute → floor 0
    expect(byId['p1']!.incidentIds).toEqual(['i1', 'i2']);
  });

  it('treats reverted as a confirm (no special weighting — the 1.5 bonus was magic)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-rev-'));
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pf({ id: 'pa', title: 'a', confidence: 0.4 }));
    await store.addPitfall(pf({ id: 'pr', title: 'r', confidence: 0.4 }));
    await store.addIncident({ id: 'i1', pitfallId: 'pa', source: 'review', outcome: 'accepted', ts: 't' });
    await store.addIncident({ id: 'i2', pitfallId: 'pr', source: 'review', outcome: 'reverted', ts: 't' });

    await consolidatePitfalls(store);
    const byId = Object.fromEntries((await store.pitfalls()).map((p) => [p.id, p]));
    expect(byId['pa']!.confidence).toBeCloseTo(wilsonLowerBound(1, 1), 10);
    expect(byId['pr']!.confidence).toBeCloseTo(byId['pa']!.confidence, 10); // reverted == accepted now
  });

  it('a NEGATIVE pitfall flips the evidence — a dismissal confirms suppression, an accept refutes it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-neg-'));
    const store = new KnowledgeStore(dir);
    // Same single 'rejected' incident, opposite polarity → opposite reading.
    await store.addPitfall(pf({ id: 'pos', polarity: 'positive' }));
    await store.addPitfall(pf({ id: 'neg', polarity: 'negative', suppressKey: 'no-console' }));
    await store.addIncident({ id: 'a', pitfallId: 'pos', source: 'review', outcome: 'rejected', ts: 't' });
    await store.addIncident({ id: 'b', pitfallId: 'neg', source: 'review', outcome: 'rejected', ts: 't' });

    await consolidatePitfalls(store);
    const byId = Object.fromEntries((await store.pitfalls()).map((p) => [p.id, p]));
    expect(byId['pos']!.confidence).toBe(0); // a reject REFUTES a positive pitfall
    expect(byId['neg']!.confidence).toBeCloseTo(wilsonLowerBound(1, 1), 10); // a reject CONFIRMS a suppression (weakly)
  });

  it('a negative pitfall: an accept/fix (user acted on it) refutes the suppression', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-neg2-'));
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pf({ id: 'neg', polarity: 'negative', suppressKey: 'no-console' }));
    for (const id of ['d1', 'd2', 'd3', 'd4']) {
      await store.addIncident({ id, pitfallId: 'neg', source: 'review', outcome: 'rejected', ts: 't' });
    }
    await store.addIncident({ id: 'fixed', pitfallId: 'neg', source: 'review', outcome: 'fixed', ts: 't' });
    await consolidatePitfalls(store);
    const neg = (await store.pitfalls()).find((p) => p.id === 'neg')!;
    expect(neg.confidence).toBeCloseTo(wilsonLowerBound(4, 5), 10); // 4 dismissals, 1 correction
  });

  it('a pitfall with no incidents keeps its prior confidence', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-prior-'));
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pf({ id: 'p1', confidence: 0.83 }));
    const res = await consolidatePitfalls(store);
    expect(res.reinforced).toBe(0);
    expect((await store.pitfalls())[0]!.confidence).toBe(0.83);
  });

  it('is idempotent — re-running with the same incidents leaves confidence put', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-idem-'));
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pf({ id: 'p1', confidence: 0.4 }));
    await store.addIncident({ id: 'i1', pitfallId: 'p1', source: 'review', outcome: 'accepted', ts: 't' });
    await store.addIncident({ id: 'i2', pitfallId: 'p1', source: 'review', outcome: 'accepted', ts: 't' });

    await consolidatePitfalls(store);
    const after1 = (await store.pitfalls())[0]!.confidence;
    expect(after1).toBeCloseTo(wilsonLowerBound(2, 2), 10);

    await consolidatePitfalls(store); // SAME incidents — pure function of counts, can't drift
    expect((await store.pitfalls())[0]!.confidence).toBeCloseTo(after1, 12);

    await store.addIncident({ id: 'i3', pitfallId: 'p1', source: 'review', outcome: 'rejected', ts: 't' });
    await consolidatePitfalls(store); // one NEW reject moves it, exactly once
    expect((await store.pitfalls())[0]!.confidence).toBeCloseTo(wilsonLowerBound(2, 3), 10); // 2 confirms / 3
    expect((await store.pitfalls())[0]!.incidentIds).toEqual(['i1', 'i2', 'i3']);
  });
});
