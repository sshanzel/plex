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

/** Is the code graph behind the working HEAD? (ADR-25 staleness signal; ADR-52 version gate.) */
export interface GraphStaleness {
  indexedSha?: string;
  /** Commits HEAD is ahead of the indexed sha (0 = fresh, -1 = unknown). */
  behind: number;
  /** True when the review auto-refreshed the graph (incremental) before proceeding. */
  refreshed?: boolean;
  /** True when the graph predates the current extractors (sidecar graph.version mismatch, ADR-52) —
   *  fires even at behind === 0, e.g. the first review after upgrading Plex at an unchanged HEAD. */
  versionMismatch?: boolean;
  /** True when a refresh RAN but left the version sidecar non-current — the rebuild degraded (a
   *  language runtime failed to load), so that language's files are missing from the graph. */
  degraded?: boolean;
}

/**
 * The staleness gate's decision (pure): whether to auto-refresh, and what to report. The version
 * gate fires even at `behind === 0` (ADR-52) — after a Plex upgrade, a graph indexed by the OLD
 * extractors is silently missing whole languages, and only a refresh (which lands on
 * `updateCodeGraph`'s Meta.graphVersion check → FullRebuildRequired → full rebuild) heals it. A
 * missing sidecar (legacy install, or a prior DEGRADED build that withheld the stamp) counts as a
 * mismatch — which is also what makes a degraded graph self-heal on later reviews. With
 * `autoIndex: false` a mismatch is REPORTED, never rebuilt. `stale.refreshed`/`degraded` are the
 * caller's to fill after it actually runs the refresh.
 */
export function graphStaleDecision(input: {
  indexedSha: string | undefined;
  behind: number;
  versionMismatch: boolean;
  autoIndex: boolean;
}): { shouldRefresh: boolean; stale?: GraphStaleness } {
  const { indexedSha, behind, versionMismatch, autoIndex } = input;
  const flag = versionMismatch ? { versionMismatch } : {};
  if (indexedSha && (behind > 0 || versionMismatch) && autoIndex) {
    return { shouldRefresh: true, stale: { indexedSha, behind, refreshed: false, ...flag } };
  }
  if (!indexedSha || behind !== 0 || versionMismatch) {
    return { shouldRefresh: false, stale: { indexedSha, behind, refreshed: false, ...flag } };
  }
  return { shouldRefresh: false };
}

/** The agent-facing staleness note (pure) — must never overstate the graph's coverage: a refresh
 *  that ran DEGRADED says so instead of claiming a current blast radius. */
export function graphStaleNote(gs: GraphStaleness | undefined): string | undefined {
  if (!gs) return undefined;
  if (gs.refreshed) {
    if (gs.degraded) {
      return 'The code graph was auto-rebuilt before this review but the rebuild ran DEGRADED — a language runtime failed to load, so that language\'s files are missing from the graph and blast radius under-reports their couplings. It self-heals on a later review once the runtime loads.';
    }
    if (gs.versionMismatch) {
      return 'The code graph predated the current extractors (Plex upgrade) and was auto-rebuilt before this review — blast radius is current.';
    }
    return `The code graph was ${gs.behind} commit(s) behind HEAD and was auto-refreshed (incremental) before this review — blast radius is current.`;
  }
  return `The code graph is ${gs.behind > 0 ? `${gs.behind} commit(s) behind` : 'out of sync with'} HEAD — blast radius may miss recently-changed or brand-new files. Re-index (\`plex index --incremental\`).`;
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
