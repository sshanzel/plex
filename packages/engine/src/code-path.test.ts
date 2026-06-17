import { describe, it, expect } from 'vitest';
import { symbolKey, type CodeLocation, type Incident, type NeighborEntry, type Pitfall } from '@plex/core';
import { buildKnowledgeGraph, type RetrievedPitfall } from '@plex/knowledge';
import { matchCodePath, applyCodePathBoost } from './code-path';

const pf = (over: Partial<Pitfall> & { id: string }): Pitfall => ({
  title: over.id, trigger: '', why: '', category: 'general', tier: 'judgmental',
  confidence: 0.5, incidentIds: [], ...over,
});
const ret = (p: Pitfall, score = 0.2): RetrievedPitfall => ({ pitfall: p, score });
const inc = (over: Partial<Incident> & { id: string }): Incident => ({
  source: 'review', ts: '2026-01-01T00:00:00Z', ...over,
});
const changedSym = (file: string, symbol: string, startLine = 10, endLine = 30): CodeLocation =>
  ({ repo: 'r', file, symbol, startLine, endLine });
const neighbor = (path: string, score: number): NeighborEntry =>
  ({ node: { id: path, label: 'File', props: { path } }, score, via: ['co-change'], distance: 1 });
// matchCodePath consumes the in-memory knowledge graph; build it from the test's pitfalls + incidents.
const run = (
  retrieved: RetrievedPitfall[], incidents: Incident[], changed: CodeLocation[], neighbors: NeighborEntry[],
  opts?: { maxIncidentsPerAlert?: number; couplingWeight?: number },
) => matchCodePath(retrieved, buildKnowledgeGraph(retrieved.map((r) => r.pitfall), incidents), changed, neighbors, opts);

describe('matchCodePath', () => {
  it('direct symbol-key hit → alert + boost', () => {
    const i = inc({ id: 'i1', file: 'a.ts', symbol: symbolKey('a.ts', 'foo'), outcome: 'rejected' });
    const p = pf({ id: 'p1', incidentIds: ['i1'] });
    const { alerts, boostByPitfall } = run([ret(p)], [i], [changedSym('a.ts', 'foo')], []);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ pitfallId: 'p1', kind: 'direct', via: 'symbol-key', symbol: 'foo' });
    expect(boostByPitfall.get('p1')).toBe(0.5); // rejected is not a sentinel outcome
  });

  it('regression sentinel: a prior FIXED at the touched symbol gets the +0.3 bonus and sorts first', () => {
    const fixed = inc({ id: 'f', file: 'a.ts', symbol: symbolKey('a.ts', 'foo'), outcome: 'fixed' });
    const plain = inc({ id: 'g', file: 'b.ts', symbol: symbolKey('b.ts', 'bar'), outcome: 'rejected' });
    const pFixed = pf({ id: 'pFixed', incidentIds: ['f'] });
    const pPlain = pf({ id: 'pPlain', incidentIds: ['g'] });
    const { alerts, boostByPitfall } = run(
      [ret(pPlain), ret(pFixed)], [fixed, plain],
      [changedSym('a.ts', 'foo'), changedSym('b.ts', 'bar')], [],
    );
    expect(boostByPitfall.get('pFixed')).toBeCloseTo(0.8, 10);
    expect(alerts[0]!.regressionSentinel).toBe(true); // sentinel sorts ahead of the plain hit
    expect(alerts[0]!.pitfallId).toBe('pFixed');
  });

  it('line-overlap fallback when the incident has no symbol key but its line is inside the changed symbol', () => {
    const i = inc({ id: 'i1', file: 'a.ts', line: 15 }); // mined: line only, no symbol
    const p = pf({ id: 'p1', incidentIds: ['i1'] });
    const { alerts } = run([ret(p)], [i], [changedSym('a.ts', 'foo', 10, 30)], []);
    expect(alerts[0]).toMatchObject({ via: 'line-overlap', symbol: 'foo' });
  });

  it('file fallback fires only for a file-level change (no named symbol), not for a symbol change', () => {
    const i = inc({ id: 'i1', file: 'a.ts', line: 999 }); // far from any symbol range
    const p = pf({ id: 'p1', incidentIds: ['i1'] });
    // symbol change at lines 10..30 → line 999 doesn't overlap, and `file` rung is gated to no-symbol → no alert
    expect(run([ret(p)], [i], [changedSym('a.ts', 'foo', 10, 30)], []).alerts).toHaveLength(0);
    // file-level change (no symbol) → file rung fires, weak boost
    const fileChange: CodeLocation = { repo: 'r', file: 'a.ts', startLine: 1, endLine: 1 };
    const r = run([ret(p)], [i], [fileChange], []);
    expect(r.alerts[0]).toMatchObject({ via: 'file', kind: 'direct' });
    expect(r.alerts[0]!.symbol).toBeUndefined();
    expect(r.boostByPitfall.get('p1')).toBe(0.25);
  });

  it('coupled hit: incident in a co-change neighbour file, scaled by PPR score; a changed+neighbour file fires DIRECT only', () => {
    const i = inc({ id: 'i1', file: 'b.ts', symbol: symbolKey('b.ts', 'bar'), outcome: 'fixed' });
    const p = pf({ id: 'p1', incidentIds: ['i1'] });
    // change a.ts; b.ts co-changes with it (score 0.7) and carries the incident → coupled
    const r = run([ret(p)], [i], [changedSym('a.ts', 'foo')], [neighbor('b.ts', 0.7)]);
    expect(r.alerts[0]).toMatchObject({ kind: 'coupled', file: 'b.ts', via: 'coupled-file', regressionSentinel: false });
    expect(r.boostByPitfall.get('p1')).toBeCloseTo(0.28, 10); // 0.4 × 0.7
    // if b.ts is BOTH changed and a neighbour, it must fire DIRECT only (no coupled double-count)
    const r2 = run([ret(p)], [i], [changedSym('b.ts', 'bar')], [neighbor('b.ts', 0.7)]);
    expect(r2.alerts.every((a) => a.kind === 'direct')).toBe(true);
  });

  it('busy file: one alert per (pitfall, kind, symbol), capped incident ids', () => {
    const incs = Array.from({ length: 9 }, (_, n) => inc({ id: `i${n}`, file: 'a.ts', symbol: symbolKey('a.ts', 'foo') }));
    const p = pf({ id: 'p1', incidentIds: incs.map((i) => i.id) });
    const { alerts } = run([ret(p)], incs, [changedSym('a.ts', 'foo')], [], { maxIncidentsPerAlert: 5 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.incidentIds).toHaveLength(5);
  });

  it('skips negative (suppression) pitfalls', () => {
    const i = inc({ id: 'i1', file: 'a.ts', symbol: symbolKey('a.ts', 'foo'), outcome: 'rejected' });
    const neg = pf({ id: 'neg', polarity: 'negative', incidentIds: ['i1'] });
    expect(run([ret(neg)], [i], [changedSym('a.ts', 'foo')], []).alerts).toHaveLength(0);
  });

  it('no false match across different symbols in the same file', () => {
    const i = inc({ id: 'i1', file: 'a.ts', symbol: symbolKey('a.ts', 'other'), line: 200 });
    const p = pf({ id: 'p1', incidentIds: ['i1'] });
    expect(run([ret(p)], [i], [changedSym('a.ts', 'foo', 10, 30)], []).alerts).toHaveLength(0);
  });
});

describe('applyCodePathBoost', () => {
  it('adds the boost, clamps to 0.99, and re-sorts so a boosted weak hit floats up', () => {
    const a = pf({ id: 'a' });
    const b = pf({ id: 'b' });
    const retrieved = [ret(a, 0.6), ret(b, 0.2)];
    const boosted = applyCodePathBoost(retrieved, new Map([['b', 0.8]]));
    expect(boosted[0]!.pitfall.id).toBe('b'); // 0.2 + 0.8 = 1.0 → clamped 0.99 > 0.6
    expect(boosted[0]!.score).toBe(0.99);
  });

  it('returns the input unchanged when there are no boosts', () => {
    const a = pf({ id: 'a' });
    const retrieved = [ret(a, 0.6)];
    expect(applyCodePathBoost(retrieved, new Map())).toBe(retrieved);
  });
});
