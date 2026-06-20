import type { IncidentOutcome } from '@plex/core';
import type { RawComment } from './types';

/**
 * The OBSERVED outcome of an analyzed review comment (ADR-44) — count only what we can observe, as a
 * graded ladder of confirm strength (ADR-50):
 *  - **strong confirm (`fixed`, weight 1)** — OUTDATED (hunk changed by a later commit) AND merged.
 *  - **weak confirm (`corroborated`, fractional `CORROBORATED_WEIGHT`)** — merged + the PR author replied in agreement, no hunk change.
 *  - **abstain (`undefined`)** — everything else; recorded for provenance, contributes NOTHING to the confidence counts.
 *
 * Deliberately ABSENT: a `rejected` (refute). Historical analysis can confirm a pattern but never refute one —
 * refutation is the live-review `record_outcome reject` path. A `fixed` confirm is probable not proven (an
 * unrelated same-hunk edit also outdates), but only ever ADDS a confirm and Wilson discounts thin evidence.
 */
export function outcomeFor(
  c: Pick<RawComment, 'outdated' | 'prMerged' | 'prAuthor' | 'replies'>,
): IncidentOutcome | undefined {
  if (!c.prMerged) return undefined; // never shipped → no confirm (outdated-but-unmerged stays ambiguous)
  if (c.outdated) return 'fixed'; // observed code change — the strongest confirm (weight 1)
  if (hasAuthorAgreement(c)) return 'corroborated'; // weaker confirm (ADR-50): PR author said they addressed it
  return undefined; // merged but no observed action → abstain (no manufactured confirm)
}

// Anchored (`^`) agreement tokens — matching mid-sentence ("I'm not sure this is fixed") would invert the meaning.
const AGREEMENT = /^\s*(done|fixed|addressed|resolved|good catch|nice catch|will fix|updated|sorted|ack|acknowledged)\b/i;

/**
 * True when the PR AUTHOR replied agreeing the comment was addressed. Gated to a reply whose author IS
 * the PR author — a different reviewer's "good catch" is not a confirm. Unknown author → abstain (no false confirm).
 */
function hasAuthorAgreement(c: Pick<RawComment, 'prAuthor' | 'replies'>): boolean {
  return (c.replies ?? []).some(
    (r) => r.author != null && c.prAuthor != null && r.author === c.prAuthor && AGREEMENT.test(r.body),
  );
}
