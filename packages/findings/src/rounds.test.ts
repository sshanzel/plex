import { describe, it, expect } from 'vitest';
import { classifyChanges, findingAddressed, findingAddressedAt, type RegionVec, type SignalVec } from './rounds';
import type { ChangedRegion } from '@plex/core';

describe('findingAddressed (ADR-28 — autonomous accept)', () => {
  it('a prior finding semantically matched by a since-change is addressed', () => {
    expect(findingAddressed([1, 0, 0], [[0, 1, 0], [0.95, 0.05, 0]], 0.6)).toBe(true);
  });
  it('a finding with no close change is not addressed', () => {
    expect(findingAddressed([1, 0, 0], [[0, 1, 0], [0, 0, 1]], 0.6)).toBe(false);
  });
  it('respects the threshold', () => {
    expect(findingAddressed([0.7, 0.7, 0], [[1, 0, 0]], 0.6)).toBe(true); // cos 0.707
    expect(findingAddressed([0.7, 0.7, 0], [[1, 0, 0]], 0.9)).toBe(false);
  });
});

describe('findingAddressedAt (ADR-28 refined — semantic OR locality)', () => {
  const f = { file: 'src/venue.ts', line: 42 };
  // The finding's TITLE embedding and the fix's ADDED-CODE embedding are orthogonal (cosine 0):
  // the restructuring fix reads nothing like the bug title, so the semantic path can NEVER fire —
  // isolating the locality signal in the tests below.
  const titleVec = [1, 0, 0];
  const fixVec = [0, 1, 0]; // cosine(titleVec, fixVec) = 0 < 0.6

  it('semantic match alone is enough (unchanged behavior)', () => {
    expect(findingAddressedAt(f, titleVec, [], [[0.95, 0.05, 0]])).toBe(true);
  });

  it('LOCALITY: a restructuring fix in the flagged file/line is addressed even when the title embedding does NOT match', () => {
    const regions: ChangedRegion[] = [{ file: 'src/venue.ts', start: 30, end: 55 }]; // line 42 ∈ range
    expect(findingAddressedAt(f, titleVec, regions, [fixVec])).toBe(true);
  });

  it('LOCALITY tolerates line drift via the window (line just outside the changed range)', () => {
    const regions: ChangedRegion[] = [{ file: 'src/venue.ts', start: 50, end: 60 }]; // 42 ∈ [20,90] via window 30
    expect(findingAddressedAt(f, titleVec, regions, [fixVec])).toBe(true);
    // ...but a change far away in the same file is NOT counted as addressing it.
    const farRegions: ChangedRegion[] = [{ file: 'src/venue.ts', start: 500, end: 520 }];
    expect(findingAddressedAt(f, titleVec, farRegions, [fixVec])).toBe(false);
  });

  it('a change in a DIFFERENT file does not address by locality (semantic still can)', () => {
    const regions: ChangedRegion[] = [{ file: 'src/other.ts', start: 40, end: 44 }];
    expect(findingAddressedAt(f, titleVec, regions, [fixVec])).toBe(false);
  });

  it('no signal at all → not addressed', () => {
    expect(findingAddressedAt(f, titleVec, [], [fixVec])).toBe(false);
  });

  it('a finding with no anchor falls back to pure semantic', () => {
    const anchorless = { file: undefined, line: undefined };
    const regions: ChangedRegion[] = [{ file: 'src/venue.ts', start: 30, end: 55 }];
    expect(findingAddressedAt(anchorless, titleVec, regions, [fixVec])).toBe(false); // no locality without an anchor
    expect(findingAddressedAt(anchorless, titleVec, regions, [[0.95, 0.05, 0]])).toBe(true); // semantic still works
  });
});

// Literal vectors — exercising the pure decision without any embedding provider.
const signals: SignalVec[] = [
  { embedding: [1, 0, 0], label: 'comment: this fires twice' },
  { embedding: [0, 1, 0], label: 'finding: missing null check' },
];

describe('classifyChanges', () => {
  it('marks a change feedback-driven when its content is semantically close to a prior signal', () => {
    const regions: RegionVec[] = [{ file: 'a.ts', start: 10, end: 14, embedding: [0.95, 0.05, 0] }];
    const out = classifyChanges(regions, signals);
    expect(out[0]).toMatchObject({ attribution: 'feedback-driven', reason: 'comment: this fires twice' });
  });

  it('marks a change unexplained when nothing is semantically close', () => {
    const regions: RegionVec[] = [{ file: 'b.ts', start: 1, end: 3, embedding: [0, 0, 1] }];
    const out = classifyChanges(regions, signals);
    expect(out[0].attribution).toBe('unexplained');
  });

  it('respects the threshold', () => {
    const regions: RegionVec[] = [{ file: 'a.ts', start: 1, end: 1, embedding: [0.7, 0.7, 0] }];
    // cosine(region, signal0) = 0.707 — explained at 0.55, unexplained at 0.9
    expect(classifyChanges(regions, signals, { threshold: 0.55 })[0].attribution).toBe('feedback-driven');
    expect(classifyChanges(regions, signals, { threshold: 0.9 })[0].attribution).toBe('unexplained');
  });

  it('cross-file matches are allowed (a comment on file X can explain a change in file Y)', () => {
    const regions: RegionVec[] = [{ file: 'venue.tsx', start: 1, end: 1, embedding: [1, 0, 0] }];
    const out = classifyChanges(regions, signals);
    expect(out[0].attribution).toBe('feedback-driven'); // matched the comment despite different file
  });
});
