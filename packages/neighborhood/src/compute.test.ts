import { describe, it, expect } from 'vitest';
import { rangesOverlap, symbolsTouchedByRanges } from './compute';
import type { SymbolRow } from '@plex/code-graph';

describe('rangesOverlap', () => {
  it('detects overlap and disjoint ranges', () => {
    expect(rangesOverlap(2, 6, 3, 4)).toBe(true); // contained
    expect(rangesOverlap(3, 5, 5, 9)).toBe(true); // touching
    expect(rangesOverlap(1, 2, 3, 4)).toBe(false); // disjoint
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
});
