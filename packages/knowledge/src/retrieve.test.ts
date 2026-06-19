import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingProvider, Pitfall } from '@plex/core';
import { KnowledgeStore } from './store';
import { FakeEmbeddingProvider } from './embeddings';
import { retrieveRelevant, retrieveRelevantLexical, lexicalTokens } from './retrieve';

const pf = (over: Partial<Pitfall> & { id: string; title: string }): Pitfall => ({
  trigger: over.title,
  why: '',
  category: 'general',
  tier: 'judgmental',
  confidence: 0.5,
  incidentIds: [],
  ...over,
});

/** n distinct ANALYZED provenance incident ids — what the recurrence tilt counts (ADR-49). */
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `inc:analyzed:${i}`);
/** n live-accept (review) incident ids — unioned into incidentIds by consolidate, but recurrence must IGNORE them. */
const reviewIds = (n: number): string[] => Array.from({ length: n }, (_, i) => `inc:src/a.ts:h${i}:t${i}`);

/** Add pitfalls to a store, embedding their `category: title` text when a provider is given. */
async function add(store: KnowledgeStore, provider: EmbeddingProvider | null, pitfalls: Pitfall[]): Promise<void> {
  const vecs = provider ? await provider.embed(pitfalls.map((p) => `${p.category}: ${p.title}`)) : [];
  for (let i = 0; i < pitfalls.length; i++) await store.addPitfall({ ...pitfalls[i]!, embedding: vecs[i] });
}

describe('seed + retrieve', () => {
  let dir: string | undefined;
  const provider = new FakeEmbeddingProvider();

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('retrieves the most relevant pitfall by embedding similarity', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-'));
    const store = new KnowledgeStore(dir);
    await add(store, provider, [
      pf({ id: 'tenant', title: 'Always validate the tenant id filter on database queries', category: 'security' }),
      pf({ id: 'const', title: 'Prefer const over let for variables that are never reassigned', category: 'style' }),
    ]);

    const results = await retrieveRelevant(store, provider, 'missing tenant id filter on a database query', 5, 0);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.pitfall.title.toLowerCase()).toContain('tenant id');
    expect(results[0]!.score).toBeGreaterThan(results[results.length - 1]!.score - 1e-9);
  });

  it('scopes repo-specific pitfalls to their origin repo (ADR-21)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-'));
    const store = new KnowledgeStore(dir);
    const [g, r] = await provider.embed(['validate tenant id query', 'use the internal RpcClient wrapper']);
    await store.addPitfall(pf({ id: 'g', title: 'validate tenant id on query', scope: 'global', embedding: g }));
    await store.addPitfall(pf({ id: 'r', title: 'use the internal RpcClient wrapper', scope: 'repo', repo: 'svc-a', embedding: r }));

    const query = 'validate tenant id query and use the internal RpcClient wrapper';
    const forA = (await retrieveRelevant(store, provider, query, 5, 0, 'svc-a')).map((x) => x.pitfall.id).sort();
    const forB = (await retrieveRelevant(store, provider, query, 5, 0, 'svc-b')).map((x) => x.pitfall.id).sort();
    expect(forA).toEqual(['g', 'r']);
    expect(forB).toEqual(['g']);
  });
});

describe('lexical retrieval (no embedding provider)', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('splits camelCase and drops stopwords', () => {
    expect(lexicalTokens('the getUserId helper should never throw')).toEqual(
      new Set(['get', 'user', 'helper', 'throw']),
    );
  });

  it('retrieves vectorless pitfalls lexically', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-'));
    const store = new KnowledgeStore(dir);
    await add(store, null, [
      pf({ id: 'tenant', title: 'Always validate the tenant id filter on database queries', category: 'security' }),
      pf({ id: 'const', title: 'Prefer const over let for variables that are never reassigned', category: 'style' }),
    ]);
    expect((await store.pitfalls()).every((p) => p.embedding == null)).toBe(true);

    const results = await retrieveRelevantLexical(store, 'missing tenantId filter on a database query');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.pitfall.title.toLowerCase()).toContain('tenant id');
    // unrelated query retrieves nothing (score floor holds)
    expect(await retrieveRelevantLexical(store, 'unrelated websocket reconnect backoff')).toEqual([]);
  });

  it('hybrid: vectorless pitfalls are still retrievable next to embedded ones', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-'));
    const store = new KnowledgeStore(dir);
    const provider = new FakeEmbeddingProvider();
    await add(store, provider, [pf({ id: 'tenant', title: 'Always validate the tenant id filter on database queries', category: 'security' })]);
    await add(store, null, [pf({ id: 'await', title: 'Avoid awaiting promises inside a for loop sequentially', category: 'async' })]);

    const results = await retrieveRelevant(store, provider, 'awaiting promises inside a for loop', 5, 0.01);
    expect(results.map((r) => r.pitfall.title)).toContain('Avoid awaiting promises inside a for loop sequentially');
  });

  it('degrades to lexical when the provider fails at query time', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-'));
    const store = new KnowledgeStore(dir);
    const provider = new FakeEmbeddingProvider();
    await add(store, provider, [pf({ id: 'tenant', title: 'Always validate the tenant id filter on database queries', category: 'security' })]);

    const failing = {
      name: 'failing',
      dimensions: provider.dimensions,
      embed: async (): Promise<number[][]> => { throw new Error('outage'); },
    };
    const results = await retrieveRelevant(store, failing, 'validate tenant id filter on database queries', 5, 0.05);
    expect(results.length).toBe(1);
    expect(results[0]!.pitfall.title.toLowerCase()).toContain('tenant id');
  });
});

describe('retrieval recency tilt (ADR-42)', () => {
  const provider = new FakeEmbeddingProvider();
  const DAY = 86_400_000;
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a stale pitfall ranks below a fresh one of equal relevance; the floor keeps it visible', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-tilt-'));
    const store = new KnowledgeStore(dir);
    const now = new Date('2026-06-01T00:00:00.000Z');
    const [qv] = await provider.embed(['tenant id validation']); // give both pitfalls the query's vector → equal cosine
    // Distinct titles (store dedups by exact title), equal embedding → tilt is the only differentiator.
    await store.addPitfall(pf({ id: 'fresh', title: 'A', embedding: qv, lastReinforcedAt: now.toISOString() }));
    await store.addPitfall(pf({ id: 'stale', title: 'B', embedding: qv, lastReinforcedAt: new Date(now.getTime() - 3650 * DAY).toISOString() }));
    const res = await retrieveRelevant(store, provider, 'tenant id validation', 5, 0, undefined, now, 365, 0.5);
    expect(res[0]!.pitfall.id).toBe('fresh');
    const stale = res.find((r) => r.pitfall.id === 'stale')!;
    const fresh = res.find((r) => r.pitfall.id === 'fresh')!;
    expect(stale).toBeDefined(); // floor (0.5) keeps the old lesson above minScore — not erased
    expect(stale.score).toBeLessThan(fresh.score);
    expect(stale.score).toBeCloseTo(fresh.score * 0.5, 6); // tilt floored at 0.5 vs fresh tilt 1
  });

  it('an undated pitfall gets full weight (tilt 1) — outranks a very stale one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-tilt2-'));
    const store = new KnowledgeStore(dir);
    const now = new Date('2026-06-01T00:00:00.000Z');
    const [qv] = await provider.embed(['tenant id validation']);
    await store.addPitfall(pf({ id: 'undated', title: 'A', embedding: qv })); // no lastReinforcedAt → tilt 1
    await store.addPitfall(pf({ id: 'stale', title: 'B', embedding: qv, lastReinforcedAt: new Date(now.getTime() - 3650 * DAY).toISOString() }));
    const res = await retrieveRelevant(store, provider, 'tenant id validation', 5, 0, undefined, now, 365, 0.5);
    expect(res[0]!.pitfall.id).toBe('undated');
  });
});

describe('retrieval confidence tilt (ADR-44 — evidence weights, never buries)', () => {
  const provider = new FakeEmbeddingProvider();
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a better-evidenced pitfall outranks a weakly-evidenced one of equal relevance', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-conf-'));
    const store = new KnowledgeStore(dir);
    const [qv] = await provider.embed(['tenant id validation']); // equal cosine for both
    await store.addPitfall(pf({ id: 'proven', title: 'A', embedding: qv, confidence: 0.9 }));
    await store.addPitfall(pf({ id: 'thin', title: 'B', embedding: qv, confidence: 0.2 }));
    const res = await retrieveRelevant(store, provider, 'tenant id validation', 5, 0);
    expect(res[0]!.pitfall.id).toBe('proven');
    const thin = res.find((r) => r.pitfall.id === 'thin')!;
    const proven = res.find((r) => r.pitfall.id === 'proven')!;
    expect(thin).toBeDefined(); // floor (0.5) keeps the weak one visible — nudged, not erased
    // proven tilt = max(.5,.9)=.9 ; thin tilt = max(.5,.2)=.5 → ratio .5/.9
    expect(thin.score).toBeCloseTo(proven.score * (0.5 / 0.9), 6);
  });

  it('a missing confidence is neutral (tilt 1) — never penalized for absent data', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-conf2-'));
    const store = new KnowledgeStore(dir);
    const [qv] = await provider.embed(['tenant id validation']);
    // pf() defaults confidence 0.5; override to undefined to model a legacy/seeded pitfall.
    await store.addPitfall(pf({ id: 'legacy', title: 'A', embedding: qv, confidence: undefined }));
    await store.addPitfall(pf({ id: 'lowconf', title: 'B', embedding: qv, confidence: 0.2 }));
    const res = await retrieveRelevant(store, provider, 'tenant id validation', 5, 0);
    expect(res[0]!.pitfall.id).toBe('legacy'); // tilt 1 (neutral) beats max(.5,.2)=.5
  });

  it('the recency and confidence tilts COMPOUND to tiltFloor² — a stale+weak pitfall can fall below minScore', async () => {
    // Honesty check for the corrected "never buries" claim: the floor bounds each axis, not the
    // product, so a stale AND weakly-evidenced pitfall is discounted by up to 0.5·0.5 = 0.25 and CAN
    // drop out — while a fresh, well-evidenced one of identical cosine survives. (Both prior tilt
    // tests use minScore 0, so this is the cut none of them exercised.) The recurrence tilt (ADR-49)
    // is excluded from the minScore gate, so it doesn't affect this cut; with equal incident counts
    // (both default n=0) it also cancels in the ratio below.
    dir = mkdtempSync(join(tmpdir(), 'kn-conf3-'));
    const store = new KnowledgeStore(dir);
    const now = new Date('2026-06-01T00:00:00.000Z');
    const DAY = 86_400_000;
    const [qv] = await provider.embed(['tenant id validation']); // cosine = 1 for both
    await store.addPitfall(pf({ id: 'strong', title: 'A', embedding: qv, confidence: 0.9 })); // fresh (undated→1) × 0.9
    await store.addPitfall(pf({ id: 'weak', title: 'B', embedding: qv, confidence: 0.2, lastReinforcedAt: new Date(now.getTime() - 3650 * DAY).toISOString() }));
    // With minScore 0 both survive and the weak score is the compounded 0.25 (= max(.5,recency)·max(.5,.2)).
    const all = await retrieveRelevant(store, provider, 'tenant id validation', 5, 0, undefined, now, 365, 0.5);
    const weak = all.find((r) => r.pitfall.id === 'weak')!;
    const strong = all.find((r) => r.pitfall.id === 'strong')!;
    expect(weak.score).toBeCloseTo(strong.score * (0.25 / 0.9), 6); // strong tilt 0.9, weak tilt 0.5·0.5
    // A cut between the two drops only the stale+weak one — the compound discount is real, not bounded at tiltFloor.
    const cut = await retrieveRelevant(store, provider, 'tenant id validation', 5, 0.5, undefined, now, 365, 0.5);
    expect(cut.map((r) => r.pitfall.id)).toEqual(['strong']);
  });
});

describe('retrieval recurrence tilt (ADR-49 — how often a lesson recurs, decay-immune)', () => {
  const provider = new FakeEmbeddingProvider();
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a long-recurring lesson outranks a one-off of equal relevance and confidence', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-rec-'));
    const store = new KnowledgeStore(dir);
    const [qv] = await provider.embed(['tenant id validation']); // equal cosine
    // Same confidence + undated → recency & confidence tilts identical; recurrence is the only differentiator.
    await store.addPitfall(pf({ id: 'recurring', title: 'A', embedding: qv, confidence: 0.5, incidentIds: ids(37) }));
    await store.addPitfall(pf({ id: 'oneoff', title: 'B', embedding: qv, confidence: 0.5, incidentIds: ids(1) }));
    const res = await retrieveRelevant(store, provider, 'tenant id validation', 5, 0);
    expect(res[0]!.pitfall.id).toBe('recurring');
    const recurring = res.find((r) => r.pitfall.id === 'recurring')!;
    const oneoff = res.find((r) => r.pitfall.id === 'oneoff')!;
    // recurring tilt = 37/38 ; one-off tilt = max(.5, 1/2) = .5 → ratio (.5)/(37/38)
    expect(oneoff.score).toBeCloseTo(recurring.score * (0.5 / (37 / 38)), 6);
  });

  it('a zero-incident pitfall stays visible (floored, not zeroed)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-rec2-'));
    const store = new KnowledgeStore(dir);
    const [qv] = await provider.embed(['tenant id validation']);
    await store.addPitfall(pf({ id: 'bare', title: 'A', embedding: qv, confidence: 0.5, incidentIds: [] }));
    const res = await retrieveRelevant(store, provider, 'tenant id validation', 5, 0.05);
    expect(res.map((r) => r.pitfall.id)).toContain('bare'); // n=0 → tilt floored at 0.5, survives
  });

  it('a negative (suppression) pitfall gets no recurrence tilt (neutral 1)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-rec3-'));
    const store = new KnowledgeStore(dir);
    const [qv] = await provider.embed(['tenant id validation']);
    // Equal cosine/confidence; the positive one has FEWER incidents but should still win, because the
    // negative pitfall is exempt from the recurrence discount (tilt 1) while the positive one is not.
    await store.addPitfall(pf({ id: 'neg', title: 'A', embedding: qv, confidence: 0.5, polarity: 'negative', incidentIds: ids(1) }));
    await store.addPitfall(pf({ id: 'pos', title: 'B', embedding: qv, confidence: 0.5, polarity: 'positive', incidentIds: ids(1) }));
    const res = await retrieveRelevant(store, provider, 'tenant id validation', 5, 0);
    const neg = res.find((r) => r.pitfall.id === 'neg')!;
    const pos = res.find((r) => r.pitfall.id === 'pos')!;
    expect(neg.score).toBeGreaterThan(pos.score); // neg tilt 1 vs pos tilt max(.5, 1/2)=.5
  });

  it('counts ANALYZED incidents only — accept-union ids do not inflate recurrence (ADR-50 review)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-rec4-'));
    const store = new KnowledgeStore(dir);
    const [qv] = await provider.embed(['tenant id validation']);
    // Both have 2 ANALYZED incidents; `inflated` also carries 20 live-accept (review) ids that
    // `consolidate` would have unioned into incidentIds. Recurrence must score them EQUAL — the accepts
    // belong to the confidence axis, not recurrence.
    await store.addPitfall(pf({ id: 'lean', title: 'A', embedding: qv, confidence: 0.5, incidentIds: ids(2) }));
    await store.addPitfall(pf({ id: 'inflated', title: 'B', embedding: qv, confidence: 0.5, incidentIds: [...ids(2), ...reviewIds(20)] }));
    const res = await retrieveRelevant(store, provider, 'tenant id validation', 5, 0);
    const lean = res.find((r) => r.pitfall.id === 'lean')!;
    const inflated = res.find((r) => r.pitfall.id === 'inflated')!;
    expect(inflated.score).toBeCloseTo(lean.score, 6); // accept volume did not lift recurrence
  });
});
