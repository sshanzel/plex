/**
 * Pure decision helpers extracted so the silent-failure guards they encode are unit-testable without
 * opening Kùzu (a `.test.ts` that opens the brain crashes vitest teardown, ADR-17). No I/O, no deps.
 */

/**
 * The headSha to persist for a review round, or `''` to skip recording it. An EMPTY sha (a
 * `git rev-parse` failure past the spawn-retry) would poison the next round's `lastHeadSha`, killing
 * fix-inference + reconcile (#2). So carry the last known anchor forward (the round still records);
 * skip ONLY when there's no prior anchor either.
 */
export function recordableHeadSha(currentHeadSha: string | undefined, lastHeadSha: string | undefined): string {
  const cur = (currentHeadSha ?? '').trim();
  if (cur !== '') return cur;
  return (lastHeadSha ?? '').trim(); // carry forward, or '' (skip) when there's nothing to carry
}

/**
 * The head to attribute changes against: the head of the round *before* `round`, NOT the latest
 * recorded round's. Anchoring on the prior round is idempotent under a same-head crash-retry replay
 * (Linux Kùzu close-time SIGSEGV) — comparing the head to itself would silently drop the
 * changed-without-feedback + fix-inference signals. Returns undefined when there's no prior anchor. Pure.
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
 * The brain outcome to project for a verdict, or `null` to skip. Returns `null` for an unknown kind OR
 * an empty/missing `findingId` (#4): an empty-id outcome write is a silent no-op that leaves the finding
 * open to be re-accepted by later fix-inference, double-counting its Wilson evidence.
 */
export function projectableOutcome(kind: string, findingId: string | undefined): string | null {
  if (!findingId) return null;
  return OUTCOME_BY_KIND[kind] ?? null;
}
