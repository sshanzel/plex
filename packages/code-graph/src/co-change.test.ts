import { describe, it, expect } from 'vitest';
import { aggregateCoChange, type CommitRecord } from './co-change';

const opts = { maxCommitFiles: 25, halfLifeDays: 365, minPairCount: 1, nowSec: 1_000_000 };

describe('aggregateCoChange', () => {
  it('weights small commits more than large ones (sizeFactor)', () => {
    const commits: CommitRecord[] = [
      { tsSec: opts.nowSec, files: ['a', 'b'] }, // 2-file: pair (a,b) gets 1/(2-1)=1
      { tsSec: opts.nowSec, files: ['c', 'd', 'e'] }, // 3-file: each pair gets 1/(3-1)=0.5
    ];
    const pairs = aggregateCoChange(commits, opts);
    const ab = pairs.find((p) => p.a === 'a' && p.b === 'b')!;
    const cd = pairs.find((p) => p.a === 'c' && p.b === 'd')!;
    expect(ab.weight).toBeCloseTo(1, 5);
    expect(cd.weight).toBeCloseTo(0.5, 5);
  });

  it('skips commits larger than maxCommitFiles (lint/format sweeps)', () => {
    const huge = Array.from({ length: 30 }, (_, i) => `f${i}`);
    const pairs = aggregateCoChange([{ tsSec: opts.nowSec, files: huge }], opts);
    expect(pairs).toEqual([]);
  });

  it('decays older co-changes by recency half-life', () => {
    const oneHalfLifeAgo = opts.nowSec - 365 * 86400;
    const pairs = aggregateCoChange([{ tsSec: oneHalfLifeAgo, files: ['a', 'b'] }], opts);
    expect(pairs[0]!.weight).toBeCloseTo(0.5, 5); // 0.5^1
  });

  it('filters pairs below minPairCount', () => {
    const commits: CommitRecord[] = [
      { tsSec: opts.nowSec, files: ['a', 'b'] },
      { tsSec: opts.nowSec, files: ['a', 'b'] },
      { tsSec: opts.nowSec, files: ['a', 'c'] },
    ];
    const pairs = aggregateCoChange(commits, { ...opts, minPairCount: 2 });
    expect(pairs.map((p) => `${p.a}-${p.b}`)).toEqual(['a-b']);
  });
});
