import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from './store';
import { FakeEmbeddingProvider } from './embeddings';
import { seedFromMarkdown, parseMarkdownPitfalls } from './seed';
import { retrieveRelevant } from './retrieve';

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
});
