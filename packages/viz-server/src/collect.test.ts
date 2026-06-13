import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pitfall, Incident } from '@plex/core';
import { KnowledgeStore } from '@plex/knowledge';
import { collectKnowledge } from './collect';

const pitfall = (over: Partial<Pitfall>): Pitfall => ({
  id: 'p1', title: 'Always close the connection', trigger: 'db.open', why: 'leaks', category: 'resource',
  tier: 'judgmental', confidence: 0.5, incidentIds: [], ...over,
});
const incident = (over: Partial<Incident>): Incident => ({ id: 'i1', source: 'review', ts: '2026-01-01T00:00:00Z', ...over });

describe('collectKnowledge', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(path.join(os.tmpdir(), 'plex-kn-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns an empty payload with a note when the store is empty', async () => {
    const p = await collectKnowledge(dir);
    expect(p.nodes).toHaveLength(0);
    expect(p.note).toMatch(/no learned pitfalls/i);
  });

  it('builds Pitfall→Incident provenance edges and types negatives as Suppression', async () => {
    const store = new KnowledgeStore(dir);
    await store.addIncident(incident({ id: 'i1', file: 'a.ts', outcome: 'fixed' }));
    await store.addIncident(incident({ id: 'i2', file: 'b.ts' }));
    await store.addPitfall(pitfall({ id: 'p1', incidentIds: ['i1', 'i2'] }));
    await store.addPitfall(pitfall({ id: 'p2', title: 'no-console here', polarity: 'negative', suppressKey: 'no-console', incidentIds: [] }));

    const payload = await collectKnowledge(dir);
    expect(payload.counts).toEqual({ Pitfall: 1, Suppression: 1, Incident: 2 });
    // two provenance edges from p1 to its incidents
    const fromP1 = payload.edges.filter((e) => e.source === 'pf:p1');
    expect(fromP1.map((e) => e.target).sort()).toEqual(['inc:i1', 'inc:i2']);
    expect(fromP1.every((e) => e.label === 'from')).toBe(true);
    const suppression = payload.nodes.find((n) => n.id === 'pf:p2')!;
    expect(suppression.type).toBe('Suppression');
    expect(suppression.props.polarity).toBe('negative');
  });

  it('never leaks the embedding vector into node props', async () => {
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pitfall({ id: 'p1', embedding: [0.1, 0.2, 0.3], incidentIds: [] }));
    const payload = await collectKnowledge(dir);
    const node = payload.nodes.find((n) => n.id === 'pf:p1')!;
    expect(node.props).not.toHaveProperty('embedding');
    expect(JSON.stringify(payload)).not.toContain('0.2');
  });
});
