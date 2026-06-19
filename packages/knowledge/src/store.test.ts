import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pitfall, Incident } from '@plex/core';
import { KnowledgeStore } from './store';

// The knowledge base is a flat JSONL store (ADR-18). Its read path is data-loss-sensitive:
// consolidation rewrites pitfalls from whatever the read returns, so a read that silently
// drops everything would erase the file. Pin the round-trip AND the corruption tolerance.
let dir: string;
const mkPitfall = (id: string, title: string): Pitfall =>
  ({ id, title, category: 'general', why: title, confidence: 0.5, tier: 'judgmental' } as Pitfall);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plex-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('KnowledgeStore', () => {
  it('returns [] for a store that was never written (missing file)', async () => {
    expect(await new KnowledgeStore(dir).pitfalls()).toEqual([]);
  });

  it('round-trips pitfalls (order + fields, incl. embedding arrays)', async () => {
    const s = new KnowledgeStore(dir);
    await s.addPitfall({ ...mkPitfall('p1', 'first'), embedding: [0.1, 0.2] } as Pitfall);
    await s.addPitfall(mkPitfall('p2', 'second'));
    const got = await s.pitfalls();
    expect(got.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(got[0]!.embedding).toEqual([0.1, 0.2]);
  });

  it('keeps the valid records when ONE line is corrupt (no total data loss)', async () => {
    // Simulates a truncated final record from an interrupted append.
    writeFileSync(join(dir, 'pitfalls.jsonl'), '{"id":"p1","title":"a"}\n{"id":"p2","title":"b"}\n{"id":"p3","tit\n');
    const got = await new KnowledgeStore(dir).pitfalls();
    expect(got.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('tolerates blank/whitespace lines in the middle of the log', async () => {
    writeFileSync(join(dir, 'pitfalls.jsonl'), '{"id":"p1","title":"a"}\n\n{"id":"p2","title":"b"}\n');
    expect((await new KnowledgeStore(dir).pitfalls()).map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('replacePitfalls([]) writes an empty file that reads back as []', async () => {
    const s = new KnowledgeStore(dir);
    await s.addPitfall(mkPitfall('p1', 'a'));
    await s.replacePitfalls([]);
    expect(await s.pitfalls()).toEqual([]);
  });

  it('append after a rewrite keeps newline framing intact (no concatenated }{ )', async () => {
    const s = new KnowledgeStore(dir);
    await s.addPitfall(mkPitfall('p1', 'a'));
    await s.replacePitfalls([mkPitfall('p1', 'a')]);
    await s.addPitfall(mkPitfall('p2', 'b'));
    expect((await s.pitfalls()).map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('replacePitfalls rewrites atomically — round-trips and leaves no .tmp behind', async () => {
    const s = new KnowledgeStore(dir);
    await s.addPitfall(mkPitfall('p1', 'a'));
    await s.addPitfall(mkPitfall('p2', 'b'));
    await s.replacePitfalls([mkPitfall('p2', 'b')]);
    expect((await s.pitfalls()).map((p) => p.id)).toEqual(['p2']);
    // the temp sibling used for the atomic write+rename must not linger
    expect(readdirSync(dir).some((f) => f.includes('.tmp'))).toBe(false);
  });

  it('hasPitfallTitled is an exact, case-sensitive title match', async () => {
    const s = new KnowledgeStore(dir);
    await s.addPitfall(mkPitfall('p1', 'Tenant filter missing'));
    expect(await s.hasPitfallTitled('Tenant filter missing')).toBe(true);
    expect(await s.hasPitfallTitled('tenant filter missing')).toBe(false);
  });

  // replaceIncidents (ADR-50) — the outcome-backfill writer. Same atomicity + corruption guarantees
  // as replacePitfalls; the backfill rewrites the WHOLE log to update analyzed incidents in place.
  const mkInc = (id: string, outcome?: Incident['outcome']): Incident =>
    ({ id, source: id.startsWith('inc:analyzed:') ? 'analyzed' : 'review', snippet: id, ts: '', ...(outcome ? { outcome } : {}) } as Incident);

  it('replaceIncidents rewrites atomically — round-trips and leaves no .tmp behind', async () => {
    const s = new KnowledgeStore(dir);
    await s.addIncident(mkInc('inc:analyzed:1'));
    await s.addIncident(mkInc('inc:review:2', 'accepted'));
    // Backfill: upgrade the analyzed incident's outcome, leave the live accept untouched.
    await s.replaceIncidents([mkInc('inc:analyzed:1', 'corroborated'), mkInc('inc:review:2', 'accepted')]);
    const got = await s.incidents();
    expect(got.map((i) => [i.id, i.outcome])).toEqual([
      ['inc:analyzed:1', 'corroborated'],
      ['inc:review:2', 'accepted'],
    ]);
    expect(readdirSync(dir).some((f) => f.includes('.tmp'))).toBe(false);
  });

  it('replaceIncidents([]) writes an empty file that reads back as []', async () => {
    const s = new KnowledgeStore(dir);
    await s.addIncident(mkInc('inc:analyzed:1'));
    await s.replaceIncidents([]);
    expect(await s.incidents()).toEqual([]);
  });

  it('a rewritten incident log keeps newline framing (append after rewrite stays parseable)', async () => {
    const s = new KnowledgeStore(dir);
    await s.replaceIncidents([mkInc('inc:analyzed:1', 'fixed')]);
    await s.addIncident(mkInc('inc:analyzed:2'));
    expect((await s.incidents()).map((i) => i.id)).toEqual(['inc:analyzed:1', 'inc:analyzed:2']);
  });
});
