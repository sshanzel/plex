import type { Finding, RankedFinding, Waiver } from '@plex/core';
import { dedupeFindings } from './dedupe';
import { computeSignal, defaultWeights, type SignalWeights } from './signal';
import { isWaived } from './waivers';

export interface RankOptions {
  waivers?: Waiver[];
  weights?: SignalWeights;
  /** Prevalence at/above which a finding is treated as a codebase norm. */
  prevalenceThreshold?: number;
  /** Cosine ≥ this lets pattern/category waivers suppress the same issue semantically (ADR-27). */
  semanticThreshold?: number;
}

const TRIAGE_PRIORITY: Record<RankedFinding['triage'], number> = {
  surface: 0,
  'systemic-migration': 1,
  awareness: 2,
  convention: 3,
  suppressed: 4,
};

/**
 * Merge, score, and triage findings into a single ranked stream (ADR-03/04/05/31).
 *
 * Triage:
 *  - waived/acknowledged → suppressed
 *  - severity awareness  → awareness (its own bucket — surfaced, never a nit)
 *  - common + bug        → systemic-migration (escalate with blast radius)
 *  - common + non-bug    → convention (demote)
 *  - otherwise           → surface
 *
 * Sorted by triage bucket, then by signal descending.
 */
export function rankFindings(findings: Finding[], opts: RankOptions = {}): RankedFinding[] {
  const waivers = opts.waivers ?? [];
  const weights = opts.weights ?? defaultWeights;
  const threshold = opts.prevalenceThreshold ?? 0.5;

  const ranked: RankedFinding[] = dedupeFindings(findings).map((f) => {
    const signal = computeSignal(f, f.agreedSources.length, weights);
    let triage: RankedFinding['triage'];
    if (isWaived(f, waivers, opts.semanticThreshold)) {
      triage = 'suppressed'; // an `acknowledge` on a matching flag lands here too
    } else if (f.severity === 'awareness') {
      triage = 'awareness';
    } else if ((f.prevalence ?? 0) >= threshold) {
      triage = f.severity === 'bug' ? 'systemic-migration' : 'convention';
    } else {
      triage = 'surface';
    }
    // `embedding` is set transiently (engine) only so `isWaived` above can match semantically —
    // it must NOT travel into the returned/persisted stream. It's a 1024-float vector no consumer
    // reads, and shipping it on every finding floods the agent's context with dead tokens (same
    // class as the retrieve.ts pitfall strip). Drop it from the result; the match already happened.
    const { embedding: _embedding, ...rest } = f;
    return { ...rest, signal, triage };
  });

  ranked.sort((a, b) => TRIAGE_PRIORITY[a.triage] - TRIAGE_PRIORITY[b.triage] || b.signal - a.signal);
  return ranked;
}
