import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pitfall } from '@plex/core';
import { KnowledgeStore } from './store';
import { FakeEmbeddingProvider } from './embeddings';
import { seedFromMarkdown, parseMarkdownPitfalls } from './seed';
import { retrieveRelevant, retrieveRelevantLexical, lexicalTokens } from './retrieve';

describe('parseMarkdownPitfalls', () => {
  it('treats headings as categories and bullets as pitfalls', () => {
    const md = '## Security\n- Always validate the tenant id\n## Performance\n- Avoid await inside loops';
    expect(parseMarkdownPitfalls(md)).toEqual([
      { title: 'Always validate the tenant id', category: 'security' },
      { title: 'Avoid await inside loops', category: 'performance' },
    ]);
  });
});

describe('seed + retrieve', () => {
  let dir: string | undefined;
  const provider = new FakeEmbeddingProvider();

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('retrieves the most relevant seeded pitfall by embedding similarity', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-'));
    const store = new KnowledgeStore(dir);
    const md = `## Security
- Always validate the tenant id filter on database queries
## Style
- Prefer const over let for variables that are never reassigned`;

    const added = await seedFromMarkdown(store, provider, md);
    expect(added).toBe(2);
    expect(await seedFromMarkdown(store, provider, md)).toBe(0); // idempotent by title

    const results = await retrieveRelevant(store, provider, 'missing tenant id filter on a database query', 5, 0);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.pitfall.title.toLowerCase()).toContain('tenant id');
    expect(results[0]!.score).toBeGreaterThan(results[results.length - 1]!.score - 1e-9);
  });

  it('scopes repo-specific pitfalls to their origin repo (ADR-21)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-'));
    const store = new KnowledgeStore(dir);
    const [g, r] = await provider.embed(['validate tenant id query', 'use the internal RpcClient wrapper']);
    const base = (over: Partial<Pitfall>): Pitfall => ({
      id: over.id!, title: over.title!, trigger: over.title!, why: '', category: 'general',
      tier: 'judgmental', confidence: 0.5, incidentIds: [], ...over,
    });
    await store.addPitfall(base({ id: 'g', title: 'validate tenant id on query', scope: 'global', embedding: g }));
    await store.addPitfall(base({ id: 'r', title: 'use the internal RpcClient wrapper', scope: 'repo', repo: 'svc-a', embedding: r }));

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

  it('seeds without a provider and retrieves lexically', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-'));
    const store = new KnowledgeStore(dir);
    const md = `## Security
- Always validate the tenant id filter on database queries
## Style
- Prefer const over let for variables that are never reassigned`;

    expect(await seedFromMarkdown(store, null, md)).toBe(2); // key-less seeding works
    const stored = await store.pitfalls();
    expect(stored.every((p) => p.embedding == null)).toBe(true);

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
    await seedFromMarkdown(store, provider, '## Security\n- Always validate the tenant id filter on database queries');
    await seedFromMarkdown(store, null, '## Async\n- Avoid awaiting promises inside a for loop sequentially');

    const results = await retrieveRelevant(store, provider, 'awaiting promises inside a for loop', 5, 0.01);
    expect(results.map((r) => r.pitfall.title)).toContain('Avoid awaiting promises inside a for loop sequentially');
  });

  it('seeding degrades to vectorless storage when the provider fails (never throws)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-seedfail-'));
    const store = new KnowledgeStore(dir);
    const failing = {
      name: 'failing',
      dimensions: 8,
      embed: async (): Promise<number[][]> => { throw new Error('outage'); },
    };
    expect(await seedFromMarkdown(store, failing, '## Security\n- Always validate the tenant id filter')).toBe(1);
    const stored = await store.pitfalls();
    expect(stored[0]!.embedding).toBeUndefined(); // vectorless — still lexically retrievable
  });

  it('degrades to lexical when the provider fails at query time', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-'));
    const store = new KnowledgeStore(dir);
    const provider = new FakeEmbeddingProvider();
    await seedFromMarkdown(store, provider, '## Security\n- Always validate the tenant id filter on database queries');

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
