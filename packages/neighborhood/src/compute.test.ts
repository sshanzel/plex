import { describe, it, expect } from 'vitest';
import { rangesOverlap, symbolsTouchedByRanges, associationStrength } from './compute';
import type { SymbolRow } from '@plex/code-graph';

describe('associationStrength (co-change promiscuity normalization)', () => {
  it('an exclusively-coupled pair scores 1', () => {
    expect(associationStrength(2, 2, 2)).toBe(1); // a and b only co-change with each other
  });
  it('a promiscuous file collapses toward 0', () => {
    expect(associationStrength(1, 10, 10)).toBeCloseTo(0.1, 5); // each co-changes with ~10 others
    expect(associationStrength(1, 100, 1)).toBeCloseTo(0.1, 5); // one barrel endpoint suffices
  });
  it('is monotonically non-increasing as a pair gets more promiscuous, and stays in (0,1]', () => {
    let prev = 1;
    for (const deg of [1, 2, 5, 20, 100]) {
      const s = associationStrength(1, deg, deg);
      expect(s).toBeLessThanOrEqual(prev);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
      prev = s;
    }
  });
  it('never exceeds 1 even if a degree is mis-reported below the pair weight', () => {
    expect(associationStrength(5, 1, 1)).toBe(1); // guarded: deg treated as ≥ co
  });
});

describe('rangesOverlap', () => {
  it('detects overlap and disjoint ranges', () => {
    expect(rangesOverlap(2, 6, 3, 4)).toBe(true); // contained
    expect(rangesOverlap(3, 5, 5, 9)).toBe(true); // touching
    expect(rangesOverlap(1, 2, 3, 4)).toBe(false); // disjoint
  });

  it('handles single-line (point) spans on the boundary', () => {
    expect(rangesOverlap(5, 5, 5, 5)).toBe(true); // point on point
    expect(rangesOverlap(1, 2, 2, 3)).toBe(true); // touch at line 2
    expect(rangesOverlap(1, 2, 3, 3)).toBe(false); // adjacent, no touch
  });
});

describe('symbolsTouchedByRanges', () => {
  const symbols: SymbolRow[] = [
    { id: 'a', name: 'UserService', kind: 'class', startLine: 2, endLine: 6 },
    { id: 'b', name: 'UserService.save', kind: 'method', startLine: 3, endLine: 5 },
    { id: 'c', name: 'helper', kind: 'function', startLine: 10, endLine: 12 },
  ];

  it('returns only symbols whose span overlaps a changed range', () => {
    const touched = symbolsTouchedByRanges(symbols, [{ start: 3, end: 4 }]);
    expect(touched.map((s) => s.name).sort()).toEqual(['UserService', 'UserService.save']);
  });

  it('returns nothing when ranges miss every symbol', () => {
    expect(symbolsTouchedByRanges(symbols, [{ start: 20, end: 21 }])).toEqual([]);
  });

  it('returns nothing for an empty range list', () => {
    expect(symbolsTouchedByRanges(symbols, [])).toEqual([]);
  });

  it('touches a symbol when a range lands exactly on its boundary line', () => {
    expect(symbolsTouchedByRanges(symbols, [{ start: 6, end: 6 }]).map((s) => s.name)).toEqual(['UserService']);
    expect(symbolsTouchedByRanges(symbols, [{ start: 12, end: 12 }]).map((s) => s.name)).toEqual(['helper']);
  });

  it('does not list a symbol twice when multiple ranges hit it', () => {
    const touched = symbolsTouchedByRanges(symbols, [{ start: 10, end: 10 }, { start: 11, end: 12 }]);
    expect(touched.map((s) => s.name)).toEqual(['helper']);
  });
});
