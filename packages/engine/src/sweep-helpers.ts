// Pure decision helpers of the maintenance worker (ADR-43). Kept here (not sweep.ts) so `review.ts`'s
// `maybeSpawnSweep` can reuse `isDebounced` without a review↔sweep import cycle.

/** A reconcile cursor marking a target whose PR is closed/gone, so the sweep stops re-probing `gh` forever. */
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
 * Condemn an empty-head PR target to the dead sentinel ONLY when `gh` confirms the PR is `CLOSED`/`MERGED`
 * — never on a transient gh failure (which also yields '' from `getPrHeadSha`/`getPrState`), so one
 * outage can't permanently disable a live PR's closure (ADR-43).
 */
export function deadPrSentinel(prState: string | undefined): boolean {
  const s = (prState ?? '').toUpperCase();
  return s === 'CLOSED' || s === 'MERGED';
}

/** Is the lock-holder process still alive? `process.kill(pid, 0)`: no throw / `EPERM` → alive; `ESRCH`
 *  → dead; unparseable pid → assume alive (conservative). Steals a crashed sweep's lock (ADR-43). */
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
