/**
 * Pure decision helpers extracted so the silent-failure guards they encode are unit-testable without
 * opening Kùzu (a `.test.ts` that opens the brain crashes vitest teardown, ADR-17). Each one closes a
 * specific swallow-to-nothing path the audit found; the call sites (brain.ts, review.ts, knowledge.ts)
 * import from here. No I/O, no deps.
 */

/**
 * Order `healSplitTarget` re-keys the four node labels when adopting a split sibling's rows — **`Round`
 * LAST, deliberately** (#6 silent-failure audit). The split signature heal detects is "canonical has
 * Findings but no Rounds of its own". The re-key is several separate `db.run`s with no transaction, so
 * a crash mid-way must leave the brain STILL detectable as split, so the next review/reconcile re-runs
 * and completes. If `Round` moved first, a crash after it would give the canonical target its own
 * rounds → the heal's early-return (`own rounds > 0`) fires forever and the remaining Findings/
 * Verdicts/Comments stay orphaned under the sibling. Moving `Round` last makes the migration
 * crash-safe and idempotent without a transaction: re-keying an already-moved label is a no-op MATCH.
 */
export const HEAL_RELABEL_ORDER = ['Comment', 'Finding', 'Verdict', 'Round'] as const;

/**
 * Whether a review round may be persisted. A round keys off its `headSha`; recording one with an empty
 * sha (a genuine `git rev-parse` failure that survived the spawn-retry) poisons the NEXT round's
 * `lastHeadSha` → `undefined`, which silently kills both fix-inference and reconcile (both gate on
 * `lastHeadSha`). Better to skip the round entirely and log than to advance round identity with no
 * anchor (#2 silent-failure audit). The first real review of any repo resolves a non-empty sha; only a
 * git failure (or a repo with no commits, which can't be reviewed anyway) trips this.
 */
export function shouldRecordRound(headSha: string | undefined): boolean {
  return (headSha ?? '').trim() !== '';
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
