import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '@plex/core';
import { KnowledgeStore, FakeEmbeddingProvider } from '@plex/knowledge';
import { inferPitfallId } from './knowledge';

const base = {
  trigger: 't',
  why: 'w',
  category: 'general',
  tier: 'judgmental' as const,
  confidence: 0.5,
  incidentIds: [],
};

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('inferPitfallId', () => {
  it('links an accepted finding title to the matching pitfall via embeddings', async () => {
    dir = mkdtempSync(join(tmpdir(), 'infer-'));
    const config = resolveConfig({ knowledgeDir: dir, embedding: { provider: 'fake' } });
    const store = new KnowledgeStore(dir);
    const provider = new FakeEmbeddingProvider();
    const [a, b] = await provider.embed([
      'always validate the tenant id filter on database queries',
      'prefer const over let for variables never reassigned',
    ]);
    await store.addPitfall({ ...base, id: 'pf-tenant', title: 'always validate the tenant id filter on database queries', embedding: a });
    await store.addPitfall({ ...base, id: 'pf-const', title: 'prefer const over let for variables never reassigned', embedding: b });

    expect(await inferPitfallId(config, 'validate the tenant id filter on database queries in listUsers')).toBe('pf-tenant');
  });

  it('falls back to lexical matching for vectorless pitfalls / key-less installs', async () => {
    dir = mkdtempSync(join(tmpdir(), 'infer-lex-'));
    const config = resolveConfig({ knowledgeDir: dir }); // provider: 'none'
    const store = new KnowledgeStore(dir);
    await store.addPitfall({ ...base, id: 'pf-await', title: 'avoid awaiting promises sequentially inside a loop' });

    expect(await inferPitfallId(config, 'sequentially awaiting promises inside the migration loop')).toBe('pf-await');
  });

  it('returns undefined rather than guessing on an unrelated title', async () => {
    dir = mkdtempSync(join(tmpdir(), 'infer-none-'));
    const config = resolveConfig({ knowledgeDir: dir });
    const store = new KnowledgeStore(dir);
    await store.addPitfall({ ...base, id: 'pf-await', title: 'avoid awaiting promises sequentially inside a loop' });

    expect(await inferPitfallId(config, 'websocket reconnect backoff is unbounded')).toBeUndefined();
    expect(await inferPitfallId(config, undefined)).toBeUndefined();
  });

  it('respects repo scoping (ADR-21): a repo-scoped pitfall only matches its origin repo', async () => {
    dir = mkdtempSync(join(tmpdir(), 'infer-scope-'));
    const config = resolveConfig({ knowledgeDir: dir });
    const store = new KnowledgeStore(dir);
    await store.addPitfall({ ...base, id: 'pf-rpc', title: 'use the internal RpcClient wrapper for service calls', scope: 'repo', repo: 'svc-a' });

    expect(await inferPitfallId(config, 'use the internal RpcClient wrapper for the service call', 'svc-a')).toBe('pf-rpc');
    expect(await inferPitfallId(config, 'use the internal RpcClient wrapper for the service call', 'svc-b')).toBeUndefined();
  });
});
