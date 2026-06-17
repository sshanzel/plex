import { describe, it, expect } from 'vitest';
import type { Finding, Severity } from '@plex/core';
import { severityWeight, computeSignal, defaultWeights } from './signal';

// Complements rank.test.ts: this file pins the severityWeight scale (incl. `note`)
// and the computeSignal edge cases — blast floor, clamping, and the agreement boundary —
// that the higher-level ranking tests don't isolate.
let n = 0;
const mk = (over: Partial<Finding> & { severity?: Severity } = {}): Finding => {
  n++;
  return {
    id: `f${n}`,
    title: `finding ${n}`,
    body: '',
    severity: over.severity ?? 'bug',
    confidence: over.confidence ?? 0.8,
    source: over.source ?? 'first-principles',
    location: over.location ?? { repo: 'r', file: 'src/a.ts', startLine: 1, endLine: 1 },
    ...over,
  };
};

describe('severityWeight', () => {
  it('orders bug > improvement > note > nit by weight', () => {
    expect(severityWeight('bug')).toBe(1);
    expect(severityWeight('improvement')).toBe(0.5);
    expect(severityWeight('note')).toBe(0.3); // M12: between improvement and nit
    expect(severityWeight('nit')).toBe(0.2);
    expect(severityWeight('bug')).toBeGreaterThan(severityWeight('improvement'));
    expect(severityWeight('improvement')).toBeGreaterThan(severityWeight('note'));
    expect(severityWeight('note')).toBeGreaterThan(severityWeight('nit'));
  });

  it('honors custom weights for bug/improvement/nit (note stays fixed)', () => {
    const w = { ...defaultWeights, bug: 10, nit: 0.01 };
    expect(severityWeight('bug', w)).toBe(10);
    expect(severityWeight('nit', w)).toBe(0.01);
    expect(severityWeight('note', w)).toBe(0.3);
  });
});

describe('computeSignal edge cases', () => {
  it('floors the blast multiplier at 0.5 — a no-blast finding is dampened, not zeroed', () => {
    const noBlast = computeSignal(mk({ severity: 'bug', confidence: 1, blastRadius: 0 }), 1);
    const fullBlast = computeSignal(mk({ severity: 'bug', confidence: 1, blastRadius: 1 }), 1);
    expect(noBlast).toBeCloseTo(0.5, 10); // 1 * 1 * 0.5 * 1 * 1
    expect(fullBlast).toBeCloseTo(1, 10);
    expect(noBlast).toBeGreaterThan(0);
  });

  it('treats a missing blastRadius as no-blast (0.5 floor)', () => {
    expect(computeSignal(mk({ severity: 'bug', confidence: 1 }), 1)).toBeCloseTo(0.5, 10);
  });

  it('clamps confidence and blast into [0,1] (out-of-range inputs do not explode the score)', () => {
    const over = computeSignal(mk({ severity: 'bug', confidence: 5, blastRadius: 9 }), 1);
    const at1 = computeSignal(mk({ severity: 'bug', confidence: 1, blastRadius: 1 }), 1);
    expect(over).toBeCloseTo(at1, 10);
    const neg = computeSignal(mk({ severity: 'bug', confidence: -3, blastRadius: -3 }), 1);
    expect(neg).toBe(0); // confidence clamps to 0 → signal 0
  });

  it('gives no agreement boost for a single source (or count ≤ 1)', () => {
    const f = mk({ severity: 'bug', confidence: 0.7 });
    const one = computeSignal(f, 1);
    expect(computeSignal(f, 0)).toBeCloseTo(one, 10); // Math.max(0, count-1) guards count=0
    expect(computeSignal(f, 2)).toBeGreaterThan(one); // 2 sources → +15%
  });

  it('does not demote a bug by prevalence, but fully applies deviation to improvement/note/nit', () => {
    for (const sev of ['improvement', 'note', 'nit'] as Severity[]) {
      const common = computeSignal(mk({ severity: sev, prevalence: 1 }), 1);
      const rare = computeSignal(mk({ severity: sev, prevalence: 0 }), 1);
      expect(common).toBeCloseTo(rare * (1 - 0.8), 10); // deviation = 1 - 0.8*prevalence
    }
    const bugCommon = computeSignal(mk({ severity: 'bug', prevalence: 1 }), 1);
    const bugRare = computeSignal(mk({ severity: 'bug', prevalence: 0 }), 1);
    expect(bugCommon).toBeCloseTo(bugRare, 10);
  });
});
