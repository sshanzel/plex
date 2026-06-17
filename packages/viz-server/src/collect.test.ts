import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pitfall, Incident } from '@plex/core';
import { KnowledgeStore } from '@plex/knowledge';
import { collectKnowledge, linkLineage } from './collect';
import type { GraphPayload, VizNode } from './model';

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

  it('nests incidents inside their pitfall (compound parent) and types negatives as Suppression', async () => {
    const store = new KnowledgeStore(dir);
    await store.addIncident(incident({ id: 'i1', file: 'a.ts', outcome: 'fixed' }));
    await store.addIncident(incident({ id: 'i2', file: 'b.ts' }));
    await store.addPitfall(pitfall({ id: 'p1', incidentIds: ['i1', 'i2'] }));
    await store.addPitfall(pitfall({ id: 'p2', title: 'no-console here', polarity: 'negative', suppressKey: 'no-console', incidentIds: [] }));

    const payload = await collectKnowledge(dir);
    expect(payload.counts).toEqual({ Pitfall: 1, Suppression: 1, Incident: 2 });
    // Clustering (ADR-45): each cited incident nests inside its pitfall via `parent` — containment
    // replaces the `from` edge, so the same-container provenance is the box, not a crossing edge.
    const i1 = payload.nodes.find((n) => n.id === 'inc:i1')!;
    const i2 = payload.nodes.find((n) => n.id === 'inc:i2')!;
    expect(i1.parent).toBe('pf:p1');
    expect(i2.parent).toBe('pf:p1');
    expect(payload.edges.filter((e) => e.source === 'pf:p1')).toEqual([]); // no redundant `from` edges
    const suppression = payload.nodes.find((n) => n.id === 'pf:p2')!;
    expect(suppression.type).toBe('Suppression');
    expect(suppression.props.polarity).toBe('negative');
  });

  it('keeps a cross-cluster `from` edge when an incident is cited by a SECOND pitfall', async () => {
    const store = new KnowledgeStore(dir);
    await store.addIncident(incident({ id: 'shared', file: 'a.ts' }));
    await store.addPitfall(pitfall({ id: 'p1', incidentIds: ['shared'] }));
    await store.addPitfall(pitfall({ id: 'p2', title: 'second', incidentIds: ['shared'] }));

    const payload = await collectKnowledge(dir);
    const shared = payload.nodes.find((n) => n.id === 'inc:shared')!;
    expect(shared.parent).toBe('pf:p1'); // first citer is the container
    // the second pitfall keeps a visible cross-cluster provenance edge (one Cytoscape parent only)
    expect(payload.edges).toContainEqual(
      expect.objectContaining({ source: 'pf:p2', target: 'inc:shared', label: 'from' }),
    );
  });

  it('does not draw both a `from` and an `about` for the same cross-cluster (pitfall, incident) pair', async () => {
    const store = new KnowledgeStore(dir);
    // `shared` is contained by p1 (first citer), but ALSO cited by p2 AND carries pitfallId p2 — the
    // `from` (p2→shared) and `about` (shared→p2) would be duplicate arrows for one link; keep one.
    await store.addIncident(incident({ id: 'shared', file: 'a.ts', pitfallId: 'p2' }));
    await store.addPitfall(pitfall({ id: 'p1', incidentIds: ['shared'] }));
    await store.addPitfall(pitfall({ id: 'p2', title: 'second', incidentIds: ['shared'] }));

    const payload = await collectKnowledge(dir);
    const between = payload.edges.filter(
      (e) => (e.source === 'pf:p2' && e.target === 'inc:shared') || (e.source === 'inc:shared' && e.target === 'pf:p2'),
    );
    expect(between).toHaveLength(1);
    expect(between[0]!.label).toBe('from');
  });

  it('never leaks the embedding vector into node props', async () => {
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pitfall({ id: 'p1', embedding: [0.1, 0.2, 0.3], incidentIds: [] }));
    const payload = await collectKnowledge(dir);
    const node = payload.nodes.find((n) => n.id === 'pf:p1')!;
    expect(node.props).not.toHaveProperty('embedding');
    expect(JSON.stringify(payload)).not.toContain('0.2');
  });

  it('repo scope keeps only pitfalls that ORIGINATED in this repo (explorer = by provenance)', async () => {
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pitfall({ id: 'g', title: 'global rule', scope: 'global' })); // no repo tag
    await store.addPitfall(pitfall({ id: 'foo', title: 'foo rule', repo: 'foo' }));
    await store.addPitfall(pitfall({ id: 'bar', title: 'bar rule', repo: 'bar' }));
    const scoped = await collectKnowledge(dir, { repo: 'foo' });
    const ids = scoped.nodes.filter((n) => n.type === 'Pitfall' || n.type === 'Suppression').map((n) => n.id).sort();
    expect(ids).toEqual(['pf:foo']); // only foo's own; untagged global + other repos excluded
    // unscoped shows everything
    const all = await collectKnowledge(dir);
    expect(all.nodes.filter((n) => n.type === 'Pitfall').length).toBe(3);
  });
});

describe('linkLineage', () => {
  const node = (id: string, type: string, graph: 'brain' | 'knowledge', props: VizNode['props']): VizNode => ({ id, label: id, type, graph, props });
  const brain: GraphPayload = {
    graph: 'brain', truncated: false, counts: {},
    nodes: [
      node('fi:1', 'Finding', 'brain', { file: 'a.ts', outcome: 'accepted' }),
      node('fi:2', 'Finding', 'brain', { file: 'a.ts', outcome: 'open' }), // not dispositioned → no bridge
      node('fi:3', 'Finding', 'brain', { file: 'b.ts', outcome: 'fixed' }), // fixed but no incident in b.ts
      node('c:1', 'Comment', 'brain', { file: 'a.ts' }),
    ],
    edges: [{ id: 'e1', source: 'c:1', target: 'fi:1', label: 'comment on', graph: 'brain' }],
  };
  const knowledge: GraphPayload = {
    graph: 'knowledge', truncated: false, counts: {},
    nodes: [node('inc:1', 'Incident', 'knowledge', { file: 'a.ts' }), node('pf:1', 'Pitfall', 'knowledge', {})],
    edges: [{ id: 'pe', source: 'pf:1', target: 'inc:1', label: 'from', graph: 'knowledge' }],
  };

  it('bridges only an accepted/fixed finding to a same-file incident, dashed + inferred', () => {
    const out = linkLineage(brain, knowledge);
    expect(out.graph).toBe('lineage');
    expect(out.nodes).toHaveLength(6); // 4 brain + 2 knowledge, merged
    const bridges = out.edges.filter((e) => e.inferred);
    expect(bridges).toHaveLength(1);
    expect(bridges[0]).toMatchObject({ source: 'fi:1', target: 'inc:1', label: 'likely became', inferred: true });
    // open finding (fi:2, same file) and the b.ts finding (no incident) produce no bridge
    expect(out.edges.some((e) => e.source === 'fi:2' && e.inferred)).toBe(false);
    expect(out.edges.some((e) => e.source === 'fi:3' && e.inferred)).toBe(false);
    // real edges from both stores are preserved
    expect(out.edges.some((e) => e.label === 'comment on' && !e.inferred)).toBe(true);
    expect(out.edges.some((e) => e.label === 'from' && !e.inferred)).toBe(true);
  });

  it('notes the worktree case when there is no brain', () => {
    const out = linkLineage({ graph: 'brain', truncated: false, counts: {}, nodes: [], edges: [] }, knowledge);
    expect(out.note).toMatch(/no pr brain/i);
  });

  it('prefers a RECORDED finding→incident edge (incident.findingId) over the inferred bridge', () => {
    // incident inc:9 records findingId '1' → matches brain finding fi:1 (id is `fi:` + findingId)
    const knowledgeRec: GraphPayload = {
      graph: 'knowledge', truncated: false, counts: {},
      nodes: [node('inc:9', 'Incident', 'knowledge', { file: 'a.ts', findingId: '1' }), node('pf:1', 'Pitfall', 'knowledge', {})],
      edges: [{ id: 'pe', source: 'pf:1', target: 'inc:9', label: 'from', graph: 'knowledge' }],
    };
    const out = linkLineage(brain, knowledgeRec);
    const rec = out.edges.find((e) => e.source === 'fi:1' && e.target === 'inc:9');
    expect(rec).toMatchObject({ label: 'became' });
    expect(rec!.inferred).toBeUndefined(); // solid, not dashed
    // fi:1 got a recorded edge, so it must NOT also get an inferred same-file bridge
    expect(out.edges.some((e) => e.source === 'fi:1' && e.inferred)).toBe(false);
    expect(out.note).toMatch(/1 recorded finding→incident/);
  });
});
