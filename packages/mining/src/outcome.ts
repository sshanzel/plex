import type { IncidentOutcome } from '@plex/core';

/**
 * Outcome of a review comment (ADR-11: outcome-weighted). Pragmatic signal: a comment on
 * a MERGED PR shipped (the review was acted on / accepted); on an unmerged PR it did not.
 * (A richer signal — was the exact suggestion applied in a later commit — is a future
 * refinement using the GraphQL `isResolved` field.)
 */
export function outcomeFor(c: { prMerged: boolean }): IncidentOutcome {
  return c.prMerged ? 'accepted' : 'rejected';
}

export function outcomeWeight(o: IncidentOutcome): number {
  if (o === 'reverted') return 1.5; // caught something the alternative got wrong
  if (o === 'accepted' || o === 'fixed') return 1;
  return 0;
}
