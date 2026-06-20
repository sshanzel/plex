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
 * So we only count what we can observe, as a graded ladder of confirm strength (ADR-50):
 *  - **strong confirm (`fixed`, weight 1)** — the comment is OUTDATED (GitHub re-anchored it because
 *    its hunk was modified by a later commit) AND the PR merged: the flagged code was changed in
 *    response and shipped. The strongest cheap, squash-merge-proof proxy that the suggestion was acted on.
 *  - **weak confirm (`corroborated`, fractional)** — the PR merged and the **PR author** REPLIED in
 *    agreement ("done"/"fixed"/"good catch") but GitHub observed no hunk change. A claimed fix, not an
 *    observed one — softer, noisier evidence, so it's weighted by `CORROBORATED_WEIGHT` (< 1) in the
 *    Wilson confidence. Reads only the thread `replies` already fetched over REST (no extra API).
 *  - **abstain (`undefined`)** — everything else. Merged-but-silent (no evidence of action),
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
export function outcomeFor(
  c: Pick<RawComment, 'outdated' | 'prMerged' | 'prAuthor' | 'replies'>,
): IncidentOutcome | undefined {
  if (!c.prMerged) return undefined; // never shipped → no confirm (outdated-but-unmerged stays ambiguous)
  if (c.outdated) return 'fixed'; // observed code change — the strongest confirm (weight 1)
  if (hasAuthorAgreement(c)) return 'corroborated'; // weaker confirm (ADR-50): PR author said they addressed it
  return undefined; // merged but no observed action → abstain (no manufactured confirm)
}

/**
 * Anchored agreement tokens — a reply that STARTS with one of these is the PR author signalling the
 * comment was addressed. Anchored (`^`) and word-bounded to mirror the `TRIVIAL` discipline in
 * classify.ts: matching mid-sentence ("I'm not sure this is fixed") would invert the meaning, so we
 * only accept the reply when agreement is its opening. Deliberately small + high-precision; it's a
 * weak confirm, and a false positive only ever ADDS confidence (analysis never refutes), bounded by
 * the fractional `CORROBORATED_WEIGHT`. ("Fixed in `<sha>`" matches via the `fixed` alternative — `\b`
 * holds at the trailing space — so no separate `fixed in` branch is needed.)
 */
const AGREEMENT = /^\s*(done|fixed|addressed|resolved|good catch|nice catch|will fix|updated|sorted|ack|acknowledged)\b/i;

/**
 * True when the PR AUTHOR replied agreeing the comment was addressed. Gated to a reply whose author IS
 * the PR author (`c.prAuthor`) — the person who received the review and made the change. A *different*
 * reviewer's "good catch" is NOT a confirm (they didn't fix anything), and the reviewer's own follow-up
 * isn't either. Conservative — if the PR author or the reply author is unknown we can't establish it,
 * so we abstain rather than risk a false confirm.
 */
function hasAuthorAgreement(c: Pick<RawComment, 'prAuthor' | 'replies'>): boolean {
  return (c.replies ?? []).some(
    (r) => r.author != null && c.prAuthor != null && r.author === c.prAuthor && AGREEMENT.test(r.body),
  );
}
