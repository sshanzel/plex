import { describe, it, expect } from 'vitest';
import { classifyChanges, findingAddressed, type RegionVec, type SignalVec } from './rounds';

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
