import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pitfall } from '@plex/core';
import { KnowledgeStore } from './store';
import { consolidatePitfalls } from './promotion';
import { wilsonLowerBound, recencyWeight } from './stats';

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

// Default knobs; undated incidents (ts:'t') decay to weight 1, so the legacy assertions stay exact.
const DECAY = { halfLifeDays: 365, pruneFloor: 0.1, pruneMinAgeDays: 365 };
const iso = (msAgo: number, now: number): string => new Date(now - msAgo).toISOString();
const DAY = 86_400_000;

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

    const res = await consolidatePitfalls(store, DECAY);
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

    await consolidatePitfalls(store, DECAY);
    const byId = Object.fromEntries((await store.pitfalls()).map((p) => [p.id, p]));
    expect(byId['pa']!.confidence).toBeCloseTo(wilsonLowerBound(1, 1), 10);
    expect(byId['pr']!.confidence).toBeCloseTo(byId['pa']!.confidence, 10);
  });

  it('a NEGATIVE pitfall flips the evidence — a dismissal confirms suppression, an accept refutes it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-neg-'));
    const store = new KnowledgeStore(dir);
    // Same single 'rejected' incident, opposite polarity → opposite reading.
    await store.addPitfall(pf({ id: 'pos', polarity: 'positive' }));
    await store.addPitfall(pf({ id: 'neg', polarity: 'negative', suppressKey: 'no-console' }));
    await store.addIncident({ id: 'a', pitfallId: 'pos', source: 'review', outcome: 'rejected', ts: 't' });
    await store.addIncident({ id: 'b', pitfallId: 'neg', source: 'review', outcome: 'rejected', ts: 't' });

    await consolidatePitfalls(store, DECAY);
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
    await consolidatePitfalls(store, DECAY);
    const neg = (await store.pitfalls()).find((p) => p.id === 'neg')!;
    expect(neg.confidence).toBeCloseTo(wilsonLowerBound(4, 5), 10); // 4 dismissals, 1 correction
  });

  it('a pitfall with no incidents keeps its prior confidence', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-prior-'));
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pf({ id: 'p1', confidence: 0.83 }));
    const res = await consolidatePitfalls(store, DECAY);
    expect(res.reinforced).toBe(0);
    expect((await store.pitfalls())[0]!.confidence).toBe(0.83);
  });

  it('a pitfall whose incidents ALL abstain keeps its prior — not crushed to Wilson(0,0)=0 (ADR-44)', async () => {
    // An incident with no informative outcome (undefined) is observed-but-uninformative. With only
    // abstentions there's zero evidence either way, so confidence must stay put — exactly like the
    // no-incidents case — rather than collapse to a confident-wrong 0.
    dir = mkdtempSync(join(tmpdir(), 'kp-abstain-'));
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pf({ id: 'p1', confidence: 0.7 }));
    await store.addIncident({ id: 'a1', pitfallId: 'p1', source: 'analyzed', ts: 't' }); // no outcome
    await store.addIncident({ id: 'a2', pitfallId: 'p1', source: 'analyzed', ts: 't' });
    const res = await consolidatePitfalls(store, DECAY);
    expect(res.reinforced).toBe(0); // no informative evidence → not counted as reinforced
    expect(res.pruned).toBe(0);
    expect((await store.pitfalls())[0]!.confidence).toBe(0.7); // prior preserved
  });

  it('is idempotent — re-running with the same incidents leaves confidence put', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-idem-'));
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pf({ id: 'p1', confidence: 0.4 }));
    await store.addIncident({ id: 'i1', pitfallId: 'p1', source: 'review', outcome: 'accepted', ts: 't' });
    await store.addIncident({ id: 'i2', pitfallId: 'p1', source: 'review', outcome: 'accepted', ts: 't' });

    await consolidatePitfalls(store, DECAY);
    const after1 = (await store.pitfalls())[0]!.confidence;
    expect(after1).toBeCloseTo(wilsonLowerBound(2, 2), 10);

    await consolidatePitfalls(store, DECAY); // SAME incidents — pure function of counts, can't drift
    expect((await store.pitfalls())[0]!.confidence).toBeCloseTo(after1, 12);

    await store.addIncident({ id: 'i3', pitfallId: 'p1', source: 'review', outcome: 'rejected', ts: 't' });
    await consolidatePitfalls(store, DECAY); // one NEW reject moves it, exactly once
    expect((await store.pitfalls())[0]!.confidence).toBeCloseTo(wilsonLowerBound(2, 3), 10); // 2 confirms / 3
    expect((await store.pitfalls())[0]!.incidentIds).toEqual(['i1', 'i2', 'i3']);
  });
});

describe('consolidatePitfalls — recency decay + pruning (ADR-42)', () => {
  it('recency-weights reinforcement: an old confirm counts for less than a fresh one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-decay-'));
    const store = new KnowledgeStore(dir);
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    await store.addPitfall(pf({ id: 'fresh', confidence: 0.4 }));
    await store.addPitfall(pf({ id: 'old', confidence: 0.4 }));
    // One confirm each — fresh (today, weight 1) vs old (300d → weight ~0.57; still above the prune
    // floor and within the quiet window, so it's reinforcement-decayed, not pruned).
    await store.addIncident({ id: 'f', pitfallId: 'fresh', source: 'review', outcome: 'accepted', ts: iso(0, now) });
    await store.addIncident({ id: 'o', pitfallId: 'old', source: 'review', outcome: 'accepted', ts: iso(300 * DAY, now) });
    await consolidatePitfalls(store, DECAY, new Date(now));
    const byId = Object.fromEntries((await store.pitfalls()).map((p) => [p.id, p]));
    const wOld = recencyWeight(300, 365);
    expect(byId['fresh']!.confidence).toBeCloseTo(wilsonLowerBound(1, 1), 6);
    expect(byId['old']!.confidence).toBeCloseTo(wilsonLowerBound(wOld, wOld), 6); // thinner (decayed) record
    expect(byId['old']!.confidence).toBeLessThan(byId['fresh']!.confidence);
    expect(byId['fresh']!.lastReinforcedAt).toBe(iso(0, now));
  });

  it('undated incidents (no parseable ts) decay to weight 1 — identical to the unweighted result', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-undated-'));
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pf({ id: 'p1', confidence: 0.4 }));
    await store.addIncident({ id: 'i1', pitfallId: 'p1', source: 'review', outcome: 'accepted', ts: 't' });
    await store.addIncident({ id: 'i2', pitfallId: 'p1', source: 'review', outcome: 'rejected', ts: '' });
    await consolidatePitfalls(store, DECAY, new Date(Date.parse('2030-01-01T00:00:00Z')));
    expect((await store.pitfalls())[0]!.confidence).toBeCloseTo(wilsonLowerBound(1, 2), 10); // 1 confirm / 2, full weight
    expect((await store.pitfalls())[0]!.lastReinforcedAt).toBeUndefined(); // no parseable ts → unset
  });

  it('prunes a pitfall that decayed below the floor AND went quiet — but keeps its incidents', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-prune-'));
    const store = new KnowledgeStore(dir);
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    // A one-off that was rejected long ago: confidence 0 (a refute) < floor, last incident 400d old.
    await store.addPitfall(pf({ id: 'stale', confidence: 0.4 }));
    await store.addIncident({ id: 'r', pitfallId: 'stale', source: 'review', outcome: 'rejected', ts: iso(400 * DAY, now) });
    const res = await consolidatePitfalls(store, DECAY, new Date(now));
    expect(res.pruned).toBe(1);
    expect((await store.pitfalls()).find((p) => p.id === 'stale')).toBeUndefined(); // pitfall gone
    expect((await store.incidents()).some((i) => i.id === 'r')).toBe(true); // provenance survives — re-derivable
  });

  it('does NOT prune a thin, NEVER-refuted lesson — even decayed below the floor and long quiet', async () => {
    // The Wilson lower bound penalizes sample thinness, so a real-but-rare lesson (1 confirm, ~700d
    // old, never rejected) decays below the floor — but it was never WRONG, so it must survive (the
    // retrieval tilt ranks it low instead). Only a contradicted lesson (refutes > 0) is a prune target.
    dir = mkdtempSync(join(tmpdir(), 'kp-rare-'));
    const store = new KnowledgeStore(dir);
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    await store.addPitfall(pf({ id: 'rare', confidence: 0.4 }));
    await store.addIncident({ id: 'c', pitfallId: 'rare', source: 'review', outcome: 'accepted', ts: iso(700 * DAY, now) });
    const res = await consolidatePitfalls(store, DECAY, new Date(now));
    const rare = (await store.pitfalls()).find((p) => p.id === 'rare')!;
    expect(rare).toBeDefined(); // not pruned (refutes === 0)
    expect(res.pruned).toBe(0);
    expect(rare.confidence).toBeLessThan(DECAY.pruneFloor); // it IS below the floor — the gate is refutes, not confidence
  });

  it('does NOT prune: high confidence, recent, zero-incident prior, or repo-scoped', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-noprune-'));
    const store = new KnowledgeStore(dir);
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    // high confidence (recurring real bug) — old but confirmed → survives ADR-05.
    await store.addPitfall(pf({ id: 'real', confidence: 0.4 }));
    for (const id of ['c1', 'c2', 'c3', 'c4']) await store.addIncident({ id, pitfallId: 'real', source: 'review', outcome: 'accepted', ts: iso(400 * DAY, now) });
    // low+old but REPO-scoped (dormant, exempt).
    await store.addPitfall(pf({ id: 'repo', scope: 'repo', repo: 'x', confidence: 0.4 }));
    await store.addIncident({ id: 'rr', pitfallId: 'repo', source: 'review', outcome: 'rejected', ts: iso(400 * DAY, now) });
    // low but RECENT (not quiet long enough).
    await store.addPitfall(pf({ id: 'recent', confidence: 0.4 }));
    await store.addIncident({ id: 'rn', pitfallId: 'recent', source: 'review', outcome: 'rejected', ts: iso(10 * DAY, now) });
    // ADR-11: zero-incident analyzed prior keeps confidence, never pruned.
    await store.addPitfall(pf({ id: 'prior', confidence: 0.2 }));
    const res = await consolidatePitfalls(store, DECAY, new Date(now));
    expect(res.pruned).toBe(0);
    const ids = new Set((await store.pitfalls()).map((p) => p.id));
    expect(ids).toEqual(new Set(['real', 'repo', 'recent', 'prior']));
    expect((await store.pitfalls()).find((p) => p.id === 'prior')!.confidence).toBe(0.2);
  });

  it('is idempotent under decay at a fixed `now` (no duplication, no drift)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp-decay-idem-'));
    const store = new KnowledgeStore(dir);
    const now = new Date(Date.parse('2026-06-01T00:00:00.000Z'));
    await store.addPitfall(pf({ id: 'p1', confidence: 0.4 }));
    await store.addIncident({ id: 'i1', pitfallId: 'p1', source: 'review', outcome: 'accepted', ts: iso(100 * DAY, now.getTime()) });
    await consolidatePitfalls(store, DECAY, now);
    const after1 = (await store.pitfalls())[0]!;
    await consolidatePitfalls(store, DECAY, now); // same now + incidents → byte-identical
    const after2 = (await store.pitfalls())[0]!;
    expect(after2.confidence).toBeCloseTo(after1.confidence, 12);
    expect(after2.lastReinforcedAt).toBe(after1.lastReinforcedAt);
    expect((await store.pitfalls()).length).toBe(1); // never duplicated
  });
});
