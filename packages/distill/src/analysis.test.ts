import { describe, it, expect } from 'vitest';
import { isSubstantive, categorize } from './classify';
import { greedyCluster, centroid } from './cluster';
import { groupThreads, parsePrList, isOutdated } from './github';
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

// #8 silent-failure audit: listPrs used a bare JSON.parse — a non-JSON gh response (auth prompt, error
// banner, empty body) threw an opaque "Unexpected token" with no hint it was gh output. parsePrList
// labels the failure; valid JSON still round-trips.
describe('parsePrList', () => {
  it('parses valid gh pr-list JSON', () => {
    expect(parsePrList('[{"number":7,"mergedAt":"2026-01-01T00:00:00Z"},{"number":8,"mergedAt":null}]')).toEqual([
      { number: 7, mergedAt: '2026-01-01T00:00:00Z' },
      { number: 8, mergedAt: null },
    ]);
  });
  it('normalizes the gh `author` object to its login string (ADR-50 reply-agreement gate)', () => {
    expect(parsePrList('[{"number":7,"mergedAt":null,"author":{"login":"pr-author","is_bot":false}}]')).toEqual([
      { number: 7, mergedAt: null, author: 'pr-author' },
    ]);
  });
  it('throws a labeled error (naming gh) on non-JSON output', () => {
    expect(() => parsePrList('gh: To get started with GitHub CLI, please run: gh auth login')).toThrow(/gh pr list did not return a JSON array/);
  });
  it('throws on valid JSON that is not an array (a {} error object would cast straight through)', () => {
    expect(() => parsePrList('{"message":"Not Found"}')).toThrow(/gh pr list did not return a JSON array/);
    expect(() => parsePrList('42')).toThrow(/JSON array/);
    expect(() => parsePrList('null')).toThrow(/JSON array/);
  });
  it('reports <empty> for a blank response', () => {
    expect(() => parsePrList('   ')).toThrow(/<empty>/);
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

// ADR-44: GitHub nulls `position` once a review comment is outdated (its hunk was changed by a later
// commit) while `original_position` persists — the cheap, squash-proof "the flagged code was changed"
// signal. Conservative: ambiguous/absent fields read as NOT outdated (abstain), never a false confirm.
describe('isOutdated', () => {
  it('is true only when position is null but the comment had an original position', () => {
    expect(isOutdated({ position: null, original_position: 12 })).toBe(true);
    expect(isOutdated({ position: 5, original_position: 12 })).toBe(false); // still anchorable → code unchanged
  });
  it('reads absent/ambiguous fields as not-outdated (never a false "addressed")', () => {
    expect(isOutdated({})).toBe(false); // both undefined — no signal
    expect(isOutdated({ position: null })).toBe(false); // a comment that never had a position
    expect(isOutdated({ original_position: null })).toBe(false);
  });
});
