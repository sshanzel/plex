import type { Finding, Severity } from '@plex/core';

export interface SignalWeights {
  bug: number;
  improvement: number;
  nit: number;
}

export const defaultWeights: SignalWeights = { bug: 1, improvement: 0.5, nit: 0.2 };

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export function severityWeight(s: Severity, w: SignalWeights = defaultWeights): number {
  return s === 'bug' ? w.bug : s === 'improvement' ? w.improvement : w.nit;
}

/**
 * signal = severity × confidence × blast × deviation × agreement   (ADR-04, ADR-05)
 *
 * - blast: 0.5..1, so a no-blast finding is dampened, not zeroed.
 * - deviation: prevalence demotes style/nits/improvements (common ⇒ convention) but
 *   NOT bugs (a common bug is systemic, handled by triage — never silenced here).
 * - agreement: cross-source corroboration boosts the signal.
 */
export function computeSignal(
  f: Finding,
  agreedSourceCount: number,
  w: SignalWeights = defaultWeights,
): number {
  const base = severityWeight(f.severity, w) * clamp01(f.confidence);
  const blast = 0.5 + 0.5 * clamp01(f.blastRadius ?? 0);
  const prevalence = clamp01(f.prevalence ?? 0);
  const deviation = f.severity === 'bug' ? 1 : 1 - 0.8 * prevalence;
  const agreement = 1 + 0.15 * Math.max(0, agreedSourceCount - 1);
  return base * blast * deviation * agreement;
}
