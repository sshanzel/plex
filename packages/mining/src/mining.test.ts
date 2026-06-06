import { describe, it, expect } from 'vitest';
import type { CompletionProvider } from '@plex/core';
import { isSubstantive, categorize } from './classify';
import { greedyCluster, centroid } from './cluster';
import { groupThreads } from './github';
import { llmDistill } from './distill';
import type { RawComment } from './types';

describe('isSubstantive', () => {
  it('drops noise and keeps substantive comments', () => {
    expect(isSubstantive('LGTM')).toBe(false);
    expect(isSubstantive('nit: spacing')).toBe(false);
    expect(isSubstantive('👍')).toBe(false);
    expect(isSubstantive('thanks!')).toBe(false);
    expect(isSubstantive('This query is missing a tenant id filter, so it leaks across tenants.')).toBe(true);
  });
});

describe('categorize', () => {
  it('maps text to a coarse category', () => {
    expect(categorize('this is vulnerable to sql injection')).toBe('security');
    expect(categorize('the error is swallowed by an empty catch')).toBe('error-handling');
    expect(categorize('please rename this variable')).toBe('general');
  });
});

describe('greedyCluster', () => {
  it('groups similar vectors and separates dissimilar ones', () => {
    const clusters = greedyCluster([[1, 0, 0], [0.9, 0.1, 0], [0, 0, 1]], 0.8);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.length).sort()).toEqual([1, 2]);
  });
  it('centroid averages rows', () => {
    expect(centroid([[2, 0], [0, 2]])).toEqual([1, 1]);
  });
});

describe('groupThreads', () => {
  it('attaches replies to their top-level comment (the discussion that reveals outcome)', () => {
    const flat: RawComment[] = [
      { id: '1', prNumber: 7, prMerged: true, body: 'This query is missing a tenant id filter' },
      { id: '2', prNumber: 7, prMerged: true, body: 'Intentional — admin queries are cross-tenant by design', inReplyToId: 1 },
      { id: '3', prNumber: 7, prMerged: true, body: 'A separate, unrelated comment' },
    ];
    const threads = groupThreads(flat);
    expect(threads.map((t) => t.id).sort()).toEqual(['1', '3']); // replies are not separate items
    const t1 = threads.find((t) => t.id === '1')!;
    expect(t1.replies).toHaveLength(1);
    expect(t1.replies![0]!.body).toContain('Intentional');
  });
});

const fakeLlm = (response: string): CompletionProvider => ({
  name: 'fake-llm',
  async complete() {
    return response;
  },
});
const mk = (id: string, body: string): RawComment => ({ id, prNumber: 1, prMerged: true, body });

describe('llmDistill (LLM decides what to store)', () => {
  const input = {
    comments: [mk('1', 'Validate the tenant id on this query'), mk('2', 'Missing tenant id check here')],
    centroid: [0.1, 0.2],
  };

  it('distills a cluster the LLM judges reusable', async () => {
    const llm = fakeLlm('{"title":"Always validate tenant id on queries","why":"Avoids cross-tenant leaks.","category":"security","tier":"judgmental"}');
    const pitfall = await llmDistill(input, llm);
    expect(pitfall).not.toBeNull();
    expect(pitfall!.title).toBe('Always validate tenant id on queries');
    expect(pitfall!.category).toBe('security');
    expect(pitfall!.incidentIds).toEqual(['inc:mined:1', 'inc:mined:2']);
    expect(pitfall!.embedding).toEqual([0.1, 0.2]);
    expect(pitfall!.confidence).toBeGreaterThan(0.4);
  });

  it('returns null when the LLM decides to skip', async () => {
    expect(await llmDistill(input, fakeLlm('{"skip": true}'))).toBeNull();
    expect(await llmDistill(input, fakeLlm('not json'))).toBeNull();
  });

  it('propagates LLM errors (a broken distiller must not silently skip)', async () => {
    const broken: CompletionProvider = { name: 'broken', async complete() { throw new Error('cli failed'); } };
    await expect(llmDistill(input, broken)).rejects.toThrow('cli failed');
  });
});
