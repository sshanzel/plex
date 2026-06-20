import type { Finding, Severity } from '@plex/core';

export interface SignalWeights {
  bug: number;
  improvement: number;
  nit: number;
}

export const defaultWeights: SignalWeights = { bug: 1, improvement: 0.5, nit: 0.2 };

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export function severityWeight(s: Severity, w: SignalWeights = defaultWeights): number {
  // `note` ranks within its own bucket (triage), so weight only orders it there.
  return s === 'bug' ? w.bug : s === 'improvement' ? w.improvement : s === 'note' ? 0.3 : w.nit;
}

/**
 * signal = severity × confidence × blast × deviation × agreement (ADR-04/05).
 * INVARIANT: prevalence demotes style/nits/improvements via `deviation`, NEVER bugs (a common bug is
 * systemic, handled by triage — never silenced here). blast is 0.5..1 (no-blast dampened, not zeroed).
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
