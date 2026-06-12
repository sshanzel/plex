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
    expect(forA).toEqual(['g', 'r']); // repo-scoped visible in its own repo
    expect(forB).toEqual(['g']); // and hidden elsewhere; global always visible
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
    expect(res[0]!.pitfall.id).toBe('fresh'); // fresh ranks first
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
