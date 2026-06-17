import { describe, it, expect } from 'vitest';
import { symbolKey, type Incident, type Pitfall } from '@plex/core';
import { buildKnowledgeGraph, historyOf, concernsAt, concernsInFile, pitfallsOf } from './graph';

const pf = (over: Partial<Pitfall> & { id: string }): Pitfall => ({
  title: over.id, trigger: '', why: '', category: 'general', tier: 'judgmental',
  confidence: 0.5, incidentIds: [], ...over,
});
const inc = (over: Partial<Incident> & { id: string }): Incident => ({ source: 'review', ts: 't', ...over });

describe('buildKnowledgeGraph', () => {
  it('links a pitfall to its incidents via the FORWARD edge (incidentIds) — the analyzed case', () => {
    // Analyzed incidents carry NO pitfallId; the only link is the pitfall's incidentIds.
    const g = buildKnowledgeGraph(
      [pf({ id: 'p', incidentIds: ['i1', 'i2'] })],
      [inc({ id: 'i1' }), inc({ id: 'i2' })],
    );
    expect(historyOf(g, 'p').map((i) => i.id).sort()).toEqual(['i1', 'i2']);
  });

  it('links via the REVERSE edge (incident.pitfallId) — the live-accept case', () => {
    const g = buildKnowledgeGraph(
      [pf({ id: 'p' })], // incidentIds empty…
      [inc({ id: 'i1', pitfallId: 'p' })], // …but the incident points back
    );
    expect(historyOf(g, 'p').map((i) => i.id)).toEqual(['i1']);
    expect(pitfallsOf(g, 'i1').map((p) => p.id)).toEqual(['p']);
  });

  it('UNIONS both directions and dedupes (the two-way-link reconciliation)', () => {
    const g = buildKnowledgeGraph(
      [pf({ id: 'p', incidentIds: ['i1', 'i2'] })],
      [inc({ id: 'i1', pitfallId: 'p' }), inc({ id: 'i2' }), inc({ id: 'i3', pitfallId: 'p' })],
    );
    // i1 (both sides), i2 (forward only), i3 (reverse only) — all present, no dupes.
    expect(historyOf(g, 'p').map((i) => i.id).sort()).toEqual(['i1', 'i2', 'i3']);
  });

  it('skips a dangling incidentId (never invents a phantom edge)', () => {
    const g = buildKnowledgeGraph([pf({ id: 'p', incidentIds: ['i1', 'gone'] })], [inc({ id: 'i1' })]);
    expect(historyOf(g, 'p').map((i) => i.id)).toEqual(['i1']);
  });

  it('indexes incidents by symbol key and by file', () => {
    const key = symbolKey('a.ts', 'foo');
    const g = buildKnowledgeGraph([], [
      inc({ id: 'i1', file: 'a.ts', symbol: key }),
      inc({ id: 'i2', file: 'a.ts' }), // file but no symbol
      inc({ id: 'i3', file: 'b.ts', symbol: symbolKey('b.ts', 'bar') }),
    ]);
    expect(concernsAt(g, key).map((i) => i.id)).toEqual(['i1']);
    expect(concernsInFile(g, 'a.ts').map((i) => i.id).sort()).toEqual(['i1', 'i2']);
    expect(concernsAt(g, symbolKey('a.ts', 'missing'))).toEqual([]);
  });

  it('empty stores produce an empty graph (no throws)', () => {
    const g = buildKnowledgeGraph([], []);
    expect(historyOf(g, 'nope')).toEqual([]);
    expect(concernsAt(g, 'x#y')).toEqual([]);
  });
});
