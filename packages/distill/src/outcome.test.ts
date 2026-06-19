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

// Reply-agreement weak confirm (ADR-50): a merged PR where the PR AUTHOR replied that they addressed
// the comment is a `corroborated` confirm — softer than an observed `fixed`, no extra API (replies are
// already fetched over REST). Gated to a reply whose author IS the PR author + an anchored agreement
// token — NOT merely a reply from someone other than the reviewer.
describe('outcomeFor — reply-agreement (corroborated)', () => {
  const prAuthor = 'pr-author';

  it('confirms (corroborated) when the PR author replies in agreement on a merged PR', () => {
    expect(
      outcomeFor({ outdated: false, prMerged: true, prAuthor, replies: [{ author: prAuthor, body: 'Done, fixed in the latest push' }] }),
    ).toBe('corroborated');
  });

  it('accepts a variety of anchored agreement tokens (incl. "Fixed in `<sha>`")', () => {
    for (const body of ['fixed', 'Fixed in `a1b2c3d`: tightened the guard', 'Good catch — addressed', 'will fix', 'updated', 'ack']) {
      expect(outcomeFor({ outdated: false, prMerged: true, prAuthor, replies: [{ author: prAuthor, body }] })).toBe('corroborated');
    }
  });

  it('`fixed` (observed change) takes precedence over a reply', () => {
    expect(
      outcomeFor({ outdated: true, prMerged: true, prAuthor, replies: [{ author: prAuthor, body: 'done' }] }),
    ).toBe('fixed');
  });

  it('abstains when the agreeing reply is NOT from the PR author (a different reviewer "good catch")', () => {
    expect(
      outcomeFor({ outdated: false, prMerged: true, prAuthor, replies: [{ author: 'second-reviewer', body: 'good catch' }] }),
    ).toBeUndefined();
  });

  it('abstains for a distinct-author NON-agreement reply (the branch a loose regex would mislabel)', () => {
    expect(
      outcomeFor({ outdated: false, prMerged: true, prAuthor, replies: [{ author: prAuthor, body: 'Why did you flag this? Leaving as-is.' }] }),
    ).toBeUndefined();
  });

  it('abstains when authorship is unknown (cannot establish the PR author replied)', () => {
    expect(outcomeFor({ outdated: false, prMerged: true, replies: [{ author: prAuthor, body: 'done' }] })).toBeUndefined(); // no prAuthor
    expect(outcomeFor({ outdated: false, prMerged: true, prAuthor, replies: [{ body: 'done' }] })).toBeUndefined(); // reply author missing
  });

  it('abstains when agreement is mid-sentence, not the opening (anchored match)', () => {
    expect(
      outcomeFor({ outdated: false, prMerged: true, prAuthor, replies: [{ author: prAuthor, body: "I'm not sure this is fixed yet" }] }),
    ).toBeUndefined();
  });

  it('abstains for a reply-agreement on an UNMERGED PR (never shipped)', () => {
    expect(
      outcomeFor({ outdated: false, prMerged: false, prAuthor, replies: [{ author: prAuthor, body: 'done' }] }),
    ).toBeUndefined();
  });
});
