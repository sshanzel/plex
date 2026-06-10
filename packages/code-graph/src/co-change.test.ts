import { describe, it, expect } from 'vitest';
import { aggregateCoChange, parseNameStatus, type CommitRecord } from './co-change';

const opts = { maxCommitFiles: 25, halfLifeDays: 365, minPairCount: 1, nowSec: 1_000_000 };

describe('parseNameStatus', () => {
  it('classifies adds, deletes, modifies, renames, and copies', () => {
    const out = [
      'A\tsrc/new.ts',
      'M\tsrc/mod.ts',
      'D\tsrc/gone.ts',
      'R095\tsrc/old.ts\tsrc/renamed.ts',
      'C080\tsrc/source.ts\tsrc/copy.ts', // emitted when copy detection is on (diff.renames=copies)
      'M\treadme.md', // not indexable — dropped
    ].join('\n');
    expect(parseNameStatus(out)).toEqual({
      added: ['src/new.ts', 'src/renamed.ts', 'src/copy.ts'],
      modified: ['src/mod.ts'],
      deleted: ['src/gone.ts', 'src/old.ts'],
    });
  });

  it('a copy never marks its unchanged source as modified', () => {
    const res = parseNameStatus('C100\tsrc/source.ts\tsrc/copy.ts');
    expect(res.modified).toEqual([]);
    expect(res.added).toEqual(['src/copy.ts']);
  });
});

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

  it('includes a commit touching EXACTLY maxCommitFiles (strict > boundary)', () => {
    const exactly = Array.from({ length: opts.maxCommitFiles }, (_, i) => `f${i}`);
    const pairs = aggregateCoChange([{ tsSec: opts.nowSec, files: exactly }], opts);
    expect(pairs.length).toBeGreaterThan(0); // 25-file commit is kept; 26 would be dropped
  });

  it('skips single-file and empty commits, and dedups files within a commit before the <2 check', () => {
    expect(aggregateCoChange([{ tsSec: opts.nowSec, files: ['a'] }], opts)).toEqual([]);
    expect(aggregateCoChange([{ tsSec: opts.nowSec, files: [] }], opts)).toEqual([]);
    expect(aggregateCoChange([{ tsSec: opts.nowSec, files: ['a', 'a'] }], opts)).toEqual([]); // dedup → 1 file → skip
  });

  it('accumulates weight and count additively for a pair seen across commits', () => {
    const pairs = aggregateCoChange(
      [
        { tsSec: opts.nowSec, files: ['a', 'b'] },
        { tsSec: opts.nowSec, files: ['a', 'b'] },
      ],
      opts,
    );
    expect(pairs[0]!.count).toBe(2);
    expect(pairs[0]!.weight).toBeCloseTo(2, 5); // 1 + 1
  });

  it('clamps recency for future-dated commits (clock skew → weight 1, never >1)', () => {
    const pairs = aggregateCoChange([{ tsSec: opts.nowSec + 99 * 86400, files: ['a', 'b'] }], opts);
    expect(pairs[0]!.weight).toBeCloseTo(1, 5);
  });

  it('treats halfLifeDays <= 0 as NO recency decay (weight 1), not NaN', () => {
    // Regression: 0.5^(0/0)=NaN for a same-instant commit poisons the edge and silently
    // drops the neighbor downstream. A non-positive half-life must mean "no decay".
    const today = aggregateCoChange([{ tsSec: opts.nowSec, files: ['a', 'b'] }], { ...opts, halfLifeDays: 0 });
    expect(Number.isNaN(today[0]!.weight)).toBe(false);
    expect(today[0]!.weight).toBeCloseTo(1, 5);
    const old = aggregateCoChange([{ tsSec: opts.nowSec - 9999 * 86400, files: ['a', 'b'] }], { ...opts, halfLifeDays: 0 });
    expect(old[0]!.weight).toBeCloseTo(1, 5); // no decay regardless of age
  });
});
