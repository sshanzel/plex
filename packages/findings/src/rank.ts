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
  /**
   * LEARNED suppression decisions, keyed by a finding tag (a deterministic rule tag). Computed
   * upstream from accumulated dismissals via Wilson (`@plex/knowledge` `suppressionTier`) and passed
   * here as a plain decision so this package stays dep-light. `'suppress'` → suppressed bucket;
   * `'demote'` → the low `demoted` bucket (still visible — a weighted "you keep skipping this", NOT a
   * one-click kill, C1). An explicit waiver always wins over a learned demote.
   */
  suppressions?: Map<string, 'suppress' | 'demote'>;
}

const TRIAGE_PRIORITY: Record<RankedFinding['triage'], number> = {
  surface: 0,
  'systemic-migration': 1,
  awareness: 2,
  convention: 3,
  demoted: 4,
  suppressed: 5,
};

/** The strongest learned-suppression decision across a finding's tags (suppress > demote). */
function learnedSuppression(
  tags: string[] | undefined,
  suppressions: Map<string, 'suppress' | 'demote'> | undefined,
): 'suppress' | 'demote' | undefined {
  if (!suppressions || !tags) return undefined;
  let demote = false;
  for (const t of tags) {
    const d = suppressions.get(t);
    if (d === 'suppress') return 'suppress';
    if (d === 'demote') demote = true;
  }
  return demote ? 'demote' : undefined;
}

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
    const learned = learnedSuppression(f.tags, opts.suppressions);
    if (isWaived(f, waivers, opts.semanticThreshold)) {
      triage = 'suppressed'; // an `acknowledge` on a matching flag lands here too
    } else if (learned === 'suppress') {
      triage = 'suppressed'; // enough consistent dismissals to be 95%-confident (Wilson) — earned
    } else if (f.severity === 'awareness') {
      triage = 'awareness';
    } else if ((f.prevalence ?? 0) >= threshold) {
      triage = f.severity === 'bug' ? 'systemic-migration' : 'convention';
    } else if (learned === 'demote') {
      triage = 'demoted'; // leaning-dismissed but not yet certain — still visible, ranked low
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
