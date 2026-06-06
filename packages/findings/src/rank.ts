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
  convention: 2,
  suppressed: 3,
};

/**
 * Merge, score, and triage findings into a single ranked stream (ADR-03/04/05).
 *
 * Triage:
 *  - waived            → suppressed
 *  - common + bug      → systemic-migration (escalate with blast radius)
 *  - common + non-bug  → convention (demote)
 *  - otherwise         → surface
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
      triage = 'suppressed';
    } else if ((f.prevalence ?? 0) >= threshold) {
      triage = f.severity === 'bug' ? 'systemic-migration' : 'convention';
    } else {
      triage = 'surface';
    }
    return { ...f, signal, triage };
  });

  ranked.sort((a, b) => TRIAGE_PRIORITY[a.triage] - TRIAGE_PRIORITY[b.triage] || b.signal - a.signal);
  return ranked;
}
