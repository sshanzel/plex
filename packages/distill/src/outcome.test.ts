import { describe, it, expect } from 'vitest';
import { outcomeFor } from './outcome';

// Observed-outcome labeling (ADR-44): analysis can positively CONFIRM a pattern but never refute it.
// A confirm requires OBSERVED action — GitHub outdated the comment (its hunk changed) AND the PR
// shipped. Everything else abstains (undefined), contributing nothing to the confidence counts
// rather than manufacturing a confirm from a bare merge.
describe('outcomeFor', () => {
  it('confirms (fixed) only when the comment was outdated AND the PR merged', () => {
    expect(outcomeFor({ outdated: true, prMerged: true })).toBe('fixed');
  });

  it('abstains (undefined) for a merged PR whose flagged code never changed', () => {
    // The old signal stamped this `accepted` — the manufactured confirm this change removes.
    expect(outcomeFor({ outdated: false, prMerged: true })).toBeUndefined();
  });

  it('abstains when the code was changed but the PR did not ship (ambiguous, not a confirm)', () => {
    expect(outcomeFor({ outdated: true, prMerged: false })).toBeUndefined();
  });

  it('abstains for an unmerged PR — never a refute (refutation is the live-review reject path)', () => {
    expect(outcomeFor({ outdated: false, prMerged: false })).toBeUndefined();
  });
});
