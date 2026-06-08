import { describe, it, expect } from 'vitest';
import { rangesOverlap, symbolsTouchedByRanges, hubWeight } from './compute';
import type { SymbolRow } from '@plex/code-graph';

describe('hubWeight (barrel/hub damping)', () => {
  it('is full weight at or below the threshold', () => {
    expect(hubWeight(1, 20)).toBe(1);
    expect(hubWeight(20, 20)).toBe(1);
  });

  it('falls off ~threshold/degree above the threshold', () => {
    expect(hubWeight(40, 20)).toBeCloseTo(0.5, 5); // a barrel imported by 40 → half
    expect(hubWeight(200, 20)).toBeCloseTo(0.1, 5); // imported by 200 → a tenth
  });

  it('is monotonically non-increasing in degree and always in (0, 1]', () => {
    let prev = 1;
    for (const d of [1, 5, 20, 50, 100, 500]) {
      const w = hubWeight(d, 20);
      expect(w).toBeLessThanOrEqual(prev);
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1);
      prev = w;
    }
  });

  it('guards degree 0 (treated as 1) — never divides by zero', () => {
    expect(hubWeight(0, 20)).toBe(1);
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
