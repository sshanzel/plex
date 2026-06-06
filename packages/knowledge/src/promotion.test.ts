import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pitfall } from '@plex/core';
import { KnowledgeStore } from './store';
import { consolidatePitfalls, proposePromotions } from './promotion';

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
  it('reinforces confidence from accepted incidents and weakens from rejected', async () => {
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
    expect(byId['p1']!.confidence).toBeCloseTo(0.6, 5); // 0.4 + 0.1*2
    expect(byId['p2']!.confidence).toBeCloseTo(0.35, 5); // 0.5 - 0.15
    expect(byId['p1']!.incidentIds).toEqual(['i1', 'i2']);
  });
});

describe('proposePromotions', () => {
  it('suggests markdown for high-confidence pitfalls and rules for codifiable ones', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp2-'));
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pf({ id: 'hi', title: 'Always validate tenant id', confidence: 0.8 }));
    await store.addPitfall(pf({ id: 'lo', title: 'Minor style thing', confidence: 0.3 }));
    await store.addPitfall(pf({ id: 'cod', title: 'No debugger statements', confidence: 0.9, tier: 'codifiable', trigger: 'debugger' }));

    const promo = await proposePromotions(store, '', 0.7);
    expect(promo.markdown).toContain('- Always validate tenant id');
    expect(promo.markdown).toContain('- No debugger statements');
    expect(promo.markdown).not.toContain('- Minor style thing');
    expect(promo.rules.join('\n')).toContain('No debugger statements');
  });

  it('does not re-suggest pitfalls already present in the markdown', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kp3-'));
    const store = new KnowledgeStore(dir);
    await store.addPitfall(pf({ id: 'hi', title: 'Always validate tenant id', confidence: 0.8 }));
    const promo = await proposePromotions(store, '- Always validate tenant id', 0.7);
    expect(promo.markdown).toEqual([]);
  });
});
