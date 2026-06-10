import { describe, it, expect } from 'vitest';
import type { IncidentOutcome } from '@plex/core';
import { outcomeFor, outcomeWeight } from './outcome';

// Outcome weighting drives analysis confidence (ADR-11). Tiny, pure, and was entirely
// untested. Pin the binary merged→accepted mapping and the full weight table so a future
// refinement (e.g. detecting `fixed`/`reverted`) is a deliberate, test-breaking change.
describe('outcomeFor', () => {
  it('maps a merged PR to accepted and an unmerged PR to rejected', () => {
    expect(outcomeFor({ prMerged: true })).toBe('accepted');
    expect(outcomeFor({ prMerged: false })).toBe('rejected');
  });
});

describe('outcomeWeight', () => {
  it('weights each outcome per ADR-11', () => {
    const table: [IncidentOutcome, number][] = [
      ['reverted', 1.5],
      ['accepted', 1],
      ['fixed', 1],
      ['rejected', 0],
    ];
    for (const [o, w] of table) expect(outcomeWeight(o)).toBe(w);
  });
});
