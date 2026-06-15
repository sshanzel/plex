/**
 * Pure decision helpers extracted so the silent-failure guards they encode are unit-testable without
 * opening Kùzu (a `.test.ts` that opens the brain crashes vitest teardown, ADR-17). Each one closes a
 * specific swallow-to-nothing path the audit found; the call sites (brain.ts, review.ts, knowledge.ts)
 * import from here. No I/O, no deps.
 */

/**
 * The headSha to persist for a review round, or `''` to skip recording it entirely.
 *
 * A round keys off its `headSha`. Recording one with an EMPTY sha (a `git rev-parse` failure that
 * survived the spawn-retry) used to poison the NEXT round's `lastHeadSha`, silently killing both
 * fix-inference and reconcile (#2 silent-failure audit). But blindly *skipping* the round is too blunt
 * (PR #10 review): a skipped round writes no Round row, so `submit_findings`'s round-free Findings
 * recreate the exact "findings, no own rounds" signature `healSplitTarget` keys on (a false-heal risk),
 * AND the round's PR comments never get ingested.
 *
 * So when the current head is unresolved, **carry the last known anchor forward**: the round still
 * records (comments persist, a Round row exists → no split signature), and the next round's
 * attribution keeps a valid anchor over the failed range. We skip ONLY when there's no prior anchor
 * either — a first-ever review whose git is broken, which can't be reviewed meaningfully anyway.
 */
export function recordableHeadSha(currentHeadSha: string | undefined, lastHeadSha: string | undefined): string {
  const cur = (currentHeadSha ?? '').trim();
  if (cur !== '') return cur;
  return (lastHeadSha ?? '').trim(); // carry forward, or '' (skip) when there's nothing to carry
}

/**
 * The head to attribute changes against on this review: the head of the round *before* `round`, NOT
 * simply the latest recorded round's head.
 *
 * Why it matters (the Linux-CI brain-check flake): Kùzu SIGSEGVs at brain-CLOSE time, right after
 * `recordRound` has durably written the current round. The harness retries by replaying the whole
 * `review`. On that replay the just-recorded round IS the latest, so "latest round's head" === the
 * current head → the changed-without-feedback + fix-inference signals are silently dropped. Anchoring
 * on the PRIOR round's head instead is idempotent under such a same-head replay: a re-review at an
 * already-recorded head reproduces the SAME attribution it computed the first time.
 *
 * `rounds` is the brain's round list (each `{n, headSha}`); returns the head of the highest-numbered
 * round strictly before `round`, or `undefined` (first round / no prior anchor → caller skips
 * attribution). Pure.
 */
export function priorRoundHeadSha(rounds: ReadonlyArray<{ n: number; headSha?: string }>, round: number): string | undefined {
  let best: { n: number; headSha?: string } | undefined;
  for (const r of rounds) {
    if (r.n < round && (best === undefined || r.n > best.n)) best = r;
  }
  return best?.headSha;
}

/** Maps an explicit verdict kind to the brain `Finding.outcome` it projects. Unknown kinds → no projection. */
export const OUTCOME_BY_KIND: Record<string, string> = {
  accept: 'accepted',
  reject: 'rejected',
  waive: 'waived',
  acknowledge: 'acknowledged',
};

/**
 * The brain outcome to project for a verdict, or `null` to skip the projection. Returns `null` for an
 * unknown kind OR an empty/missing `findingId` (#4 silent-failure audit): `markFindingOutcome('')`
 * runs a `MATCH (fi:Finding {id:''})` that matches nothing, so the disposition is silently lost — the
 * finding stays open and gets re-accepted by later fix-inference, double-counting its Wilson evidence.
 * Skipping the no-op write surfaces the real boundary (an empty id is rejected at the MCP/CLI edge).
 */
export function projectableOutcome(kind: string, findingId: string | undefined): string | null {
  if (!findingId) return null;
  return OUTCOME_BY_KIND[kind] ?? null;
}
