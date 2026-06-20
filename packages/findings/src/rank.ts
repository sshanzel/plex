import type { Finding, RankedFinding, Waiver } from '@plex/core';
import { symbolKey } from '@plex/core';
import { dedupeFindings } from './dedupe';
import { computeSignal, defaultWeights, type SignalWeights } from './signal';
import { isWaived } from './waivers';

/** A learned-suppression decision as the pure ranker consumes it (location scope folded in, ADR-48). */
export interface LearnedSuppression {
  tier: 'suppress' | 'demote';
  /** `true` ⇒ applies everywhere; `false` ⇒ only at a finding whose `file#name` is in `symbols`. */
  repoWide: boolean;
  symbols?: Set<string>;
}

export interface RankOptions {
  waivers?: Waiver[];
  weights?: SignalWeights;
  /** Prevalence at/above which a finding is treated as a codebase norm. */
  prevalenceThreshold?: number;
  /** Cosine ≥ this lets pattern/category waivers suppress the same issue semantically (ADR-27). */
  semanticThreshold?: number;
  /**
   * LEARNED suppression decisions, keyed by a finding tag. `'suppress'` → suppressed bucket; `'demote'`
   * → the low `demoted` bucket (still visible, NOT a one-click kill, C1); an explicit waiver wins over
   * a demote. Each carries a LOCATION SCOPE (ADR-48): `repoWide`, else matches only a finding whose
   * `file#name` is in `symbols` — so dismissing one `console.log` never silences the rule elsewhere.
   */
  suppressions?: Map<string, LearnedSuppression>;
}

const TRIAGE_PRIORITY: Record<RankedFinding['triage'], number> = {
  surface: 0,
  'systemic-migration': 1,
  note: 2,
  convention: 3,
  demoted: 4,
  suppressed: 5,
};

/**
 * The strongest learned-suppression decision across a finding's tags (suppress > demote), gated by
 * LOCATION (ADR-48): applies only if `repoWide` OR the finding's `file#name` is in the dismissed symbols.
 */
function learnedSuppression(
  f: Finding,
  suppressions: Map<string, LearnedSuppression> | undefined,
): 'suppress' | 'demote' | undefined {
  if (!suppressions || !f.tags) return undefined;
  const symbolMatches = (d: LearnedSuppression): boolean =>
    d.repoWide ||
    (f.location.symbol != null && (d.symbols?.has(symbolKey(f.location.file, f.location.symbol)) ?? false));
  let demote = false;
  for (const t of f.tags) {
    const d = suppressions.get(t);
    if (!d || !symbolMatches(d)) continue;
    if (d.tier === 'suppress') return 'suppress';
    if (d.tier === 'demote') demote = true;
  }
  return demote ? 'demote' : undefined;
}

/**
 * Merge, score, and triage findings into a single ranked stream (ADR-03/04/05/31).
 *
 * Triage:
 *  - waived/acknowledged → suppressed
 *  - severity note       → note (its own bucket — surfaced, never a nit)
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
    const learned = learnedSuppression(f, opts.suppressions);
    if (isWaived(f, waivers, opts.semanticThreshold)) {
      triage = 'suppressed';
    } else if (learned === 'suppress') {
      triage = 'suppressed';
    } else if (f.severity === 'note') {
      triage = 'note';
    } else if ((f.prevalence ?? 0) >= threshold) {
      triage = f.severity === 'bug' ? 'systemic-migration' : 'convention';
    } else if (learned === 'demote') {
      triage = 'demoted'; // leaning-dismissed but not yet certain — still visible, ranked low
    } else {
      triage = 'surface';
    }
    // Strip the transient `embedding` (set by engine only for `isWaived` above): it must NOT travel
    // into the returned/persisted stream — a per-finding vector no consumer reads floods agent context.
    const { embedding: _embedding, ...rest } = f;
    return { ...rest, signal, triage };
  });

  ranked.sort((a, b) => TRIAGE_PRIORITY[a.triage] - TRIAGE_PRIORITY[b.triage] || b.signal - a.signal);
  return ranked;
}
