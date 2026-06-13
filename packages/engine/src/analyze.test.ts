import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '@plex/core';
import { KnowledgeStore, FakeEmbeddingProvider, wilsonLowerBound } from '@plex/knowledge';
import { addAnalyzedPitfalls } from './analyze';

// ADR-44: the agent-driven `add_pitfalls` path derives a pitfall's default confidence from its linked
// provenance incidents using the SAME Wilson estimator the standalone distiller uses — no `0.6` magic
// default. This is the twin of the distill-path change; it gets its own test because the wiring
// (build `outcomeById` from the store, look up each incidentId) is what can silently go wrong. Uses the
// JSON KnowledgeStore + FakeEmbeddingProvider — no Kùzu, so it's a safe vitest unit (ADR-17).
describe('addAnalyzedPitfalls — confidence from provenance (ADR-44)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'add-pf-'));
    return { config: resolveConfig({ knowledgeDir: dir, embedding: { provider: 'fake' } }), store: new KnowledgeStore(dir) };
  };
  const confidenceOf = async (store: KnowledgeStore, title: string) =>
    (await store.pitfalls()).find((p) => p.title === title)!.confidence;

  it('derives the Wilson lower bound of the linked incidents’ observed confirm rate', async () => {
    const { config, store } = setup();
    await store.addIncident({ id: 'inc:analyzed:1', source: 'analyzed', outcome: 'fixed', ts: 't' });
    await store.addIncident({ id: 'inc:analyzed:2', source: 'analyzed', outcome: 'fixed', ts: 't' });
    const { added } = await addAnalyzedPitfalls(
      config,
      [{ title: 'two observed fixes', why: 'w', category: 'general', incidentIds: ['inc:analyzed:1', 'inc:analyzed:2'] }],
      'repoX',
    );
    expect(added).toBe(1);
    expect(await confidenceOf(store, 'two observed fixes')).toBeCloseTo(wilsonLowerBound(2, 2), 10);
  });

  it('an incidentId with no stored incident abstains → confidence 0 (the silent missing-incident path)', async () => {
    const { config, store } = setup();
    // outcomeById is built from store.incidents() at call time; an unresolved id maps to undefined →
    // abstain → wilson(0,0) = 0, NOT a fabricated confirm. Pin that fallback so it can't drift.
    await addAnalyzedPitfalls(
      config,
      [{ title: 'dangling provenance', why: 'w', category: 'general', incidentIds: ['inc:analyzed:missing'] }],
      'repoX',
    );
    expect(await confidenceOf(store, 'dangling provenance')).toBe(0);
  });

  it('an explicit agent-supplied confidence overrides the derivation', async () => {
    const { config, store } = setup();
    await addAnalyzedPitfalls(
      config,
      [{ title: 'explicit conf', why: 'w', category: 'general', confidence: 0.42, incidentIds: [] }],
      'repoX',
    );
    expect(await confidenceOf(store, 'explicit conf')).toBe(0.42);
  });
});
