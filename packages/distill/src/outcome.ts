import type { IncidentOutcome } from '@plex/core';
import type { RawComment } from './types';

/**
 * The OBSERVED outcome of an analyzed review comment — grounded in what actually happened to the
 * code, not an assumption about it (ADR-44).
 *
 * The old signal was `prMerged ? 'accepted' : 'rejected'`: it *manufactured a confirm* from a PR-level
 * event ("merged ⇒ the reviewer was right"), even when the author silently ignored the comment and
 * merged anyway. That assumption is itself the kind of arbitrary value we don't want feeding the
 * (otherwise principled) Wilson confidence estimator — a comment that shipped UNCHANGED is no evidence
 * it was accepted.
 *
 * So we only count what we can observe:
 *  - **confirm (`fixed`)** — the comment is OUTDATED (GitHub re-anchored it because its hunk was
 *    modified by a later commit) AND the PR merged: the flagged code was changed in response and
 *    shipped. The strongest cheap, squash-merge-proof proxy that the suggestion was acted on.
 *  - **abstain (`undefined`)** — everything else. Merged-but-unchanged (no evidence of action),
 *    outdated-but-unmerged (acted on but didn't ship — ambiguous), or no anchor at all. We record
 *    the incident for provenance but contribute NOTHING to the confidence counts rather than guess.
 *
 * Note what's deliberately ABSENT: a `rejected` (refute). Historical PR analysis can positively
 * confirm a pattern but never refute one — an unmerged PR says nothing about a comment's validity.
 * Refutation requires a human explicitly dismissing the finding in a live review (`record_outcome
 * reject`), which is the separate, intentional negative-knowledge path.
 *
 * Heuristic caveat (why a confirm is `fixed`, not certainty): an unrelated edit elsewhere in the same
 * hunk also outdates the comment, so an outdated+merged comment is a *probable* fix, not a proven one.
 * That residual false-positive only ever ADDS a confirm; it never silences a finding, and the Wilson
 * lower bound discounts thin evidence — so the failure mode is bounded.
 */
export function outcomeFor(c: Pick<RawComment, 'outdated' | 'prMerged'>): IncidentOutcome | undefined {
  return c.outdated && c.prMerged ? 'fixed' : undefined;
}
