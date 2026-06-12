// Pure decision helpers of the maintenance worker (ADR-43) — no I/O, unit-tested with literal values.
// They live here (not in sweep.ts) so `review.ts`'s `maybeSpawnSweep` can reuse `isDebounced` without
// pulling in sweep.ts's heavy deps (which import review.ts) — i.e. no review↔sweep import cycle.

/** A reconcile cursor value marking a target whose PR is closed/gone — so the sweep stops re-probing
 *  `gh` for it forever (`getPrHeadSha` returns '' for a dead PR, which never advances a sha cursor). */
export const CLOSED_TARGET = '__closed__';

/** Has main's head advanced past the per-target cursor? Undefined cursor → yes (first sweep). An
 *  unresolved head → false (nothing to do). */
export function headAdvanced(cursor: string | undefined, currentHead: string | undefined): boolean {
  if (!currentHead) return false;
  return cursor !== currentHead;
}

/** A target previously found dead (closed PR) — skip it BEFORE the `gh` probe, not after. */
export function isDeadTarget(cursor: string | undefined): boolean {
  return cursor === CLOSED_TARGET;
}

/**
 * Should an empty-head PR target be condemned to the dead sentinel? Only when `gh` *confirms* the PR
 * is `CLOSED`/`MERGED` — NOT on a transient gh failure (which also yields '' from `getPrHeadSha`/
 * `getPrState`, e.g. network/rate-limit/auth, or gh missing in the detached sweep env). A transient
 * empty just retries next sweep; a genuinely closed PR stops being re-probed forever (ADR-43).
 */
export function deadPrSentinel(prState: string | undefined): boolean {
  const s = (prState ?? '').toUpperCase();
  return s === 'CLOSED' || s === 'MERGED';
}

/** Is the lock-holder process still alive? `process.kill(pid, 0)` signals nothing but probes existence:
 *  no throw / `EPERM` (exists, other user) → alive; `ESRCH` (no such process) → dead. An unparseable
 *  pid → assume alive (conservative — don't steal a lock we can't reason about). Used to steal a
 *  CRASHED sweep's lock immediately instead of waiting out the 30-min mtime staleness (ADR-43). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Debounce: true (skip) when the marker is younger than the interval. Undefined marker → never debounced. */
export function isDebounced(markerMtimeMs: number | undefined, nowMs: number, intervalMs: number): boolean {
  return markerMtimeMs != null && nowMs - markerMtimeMs < intervalMs;
}

/** Cadence gate for a periodic job: true (run) when it has never run or the interval has elapsed. */
export function jobDue(lastRunIso: string | undefined, nowMs: number, intervalMs: number): boolean {
  if (!lastRunIso) return true;
  const t = Date.parse(lastRunIso);
  return Number.isNaN(t) || nowMs - t >= intervalMs;
}
