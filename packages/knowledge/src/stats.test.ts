import { describe, it, expect } from 'vitest';
import type { IncidentOutcome } from '@plex/core';
import { wilsonLowerBound, confidenceFromOutcomes, suppressionTier, recencyWeight, decayedCounts, type Dismissal } from './stats';

describe('wilsonLowerBound', () => {
  it('returns 0 with no observations', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
  it('discounts a thin perfect record far below 1.0', () => {
    const one = wilsonLowerBound(1, 1);
    const ten = wilsonLowerBound(10, 10);
    expect(one).toBeLessThan(0.3); // 1/1 is not trustworthy
    expect(ten).toBeGreaterThan(one); // more clean evidence ⇒ higher floor
    expect(ten).toBeLessThan(1); // …but still below the raw 100%
  });
  it('a larger clean sample ⇒ a tighter (higher) lower bound, monotonically', () => {
    let prev = 0;
    for (const n of [2, 5, 20, 100]) {
      const w = wilsonLowerBound(n, n);
      expect(w).toBeGreaterThan(prev);
      prev = w;
    }
  });
  it('rejects pull the bound down', () => {
    expect(wilsonLowerBound(8, 10)).toBeLessThan(wilsonLowerBound(10, 10));
  });
});

describe('confidenceFromOutcomes (one Wilson definition of confidence)', () => {
  const O = (...os: (IncidentOutcome | undefined)[]) => os;
  it('is the Wilson lower bound of the confirm rate — identical to the raw estimator', () => {
    expect(confidenceFromOutcomes(O('fixed', 'fixed'))).toBe(wilsonLowerBound(2, 2));
    expect(confidenceFromOutcomes(O('accepted', 'rejected', 'fixed'))).toBe(wilsonLowerBound(2, 3));
  });
  it('treats accepted, fixed, and reverted all as confirms; rejected as a refute', () => {
    expect(confidenceFromOutcomes(O('accepted', 'fixed', 'reverted'))).toBe(wilsonLowerBound(3, 3));
    expect(confidenceFromOutcomes(O('rejected', 'rejected'))).toBe(wilsonLowerBound(0, 2));
  });
  it('ABSTAINS on undefined/uninformative outcomes — they drop from the counts, not count as a confirm', () => {
    // The whole point of ADR-44: a merged-but-unchanged comment (→ undefined) is NOT a manufactured
    // confirm. One confirm + two abstains is a 1/1 record, not 1/3.
    expect(confidenceFromOutcomes(O('fixed', undefined, undefined))).toBe(wilsonLowerBound(1, 1));
  });
  it('no informative evidence → 0 (honest floor, not a guess)', () => {
    expect(confidenceFromOutcomes(O(undefined, undefined))).toBe(0);
    expect(confidenceFromOutcomes([])).toBe(0);
  });
  it('weights a `corroborated` confirm fractionally (ADR-50) — a weak confirm is not a full one', () => {
    // One corroborated reply-agreement is half a confirm by default (CORROBORATED_WEIGHT 0.5).
    expect(confidenceFromOutcomes(O('corroborated'))).toBe(wilsonLowerBound(0.5, 0.5));
    expect(confidenceFromOutcomes(O('corroborated'))).toBeLessThan(confidenceFromOutcomes(O('fixed')));
    // A full fix + a corroborated → 1.5 confirms over 1.5 trials.
    expect(confidenceFromOutcomes(O('fixed', 'corroborated'))).toBe(wilsonLowerBound(1.5, 1.5));
    // The weight is overridable (tunable without touching the constant).
    expect(confidenceFromOutcomes(O('corroborated'), 0.3)).toBe(wilsonLowerBound(0.3, 0.3));
  });
});

describe('suppressionTier (Wilson-derived, no hand-tuned floors)', () => {
  it('one dismissal never suppresses — C1: a "not now" must not bury a finding', () => {
    expect(suppressionTier(1, 0)).not.toBe('suppress'); // 1/1 interval is far too wide
  });

  it('escalates from demote to suppress only as consistent dismissals accrue', () => {
    // 1–3 consistent dismissals: leaning, not yet 95%-confident → demote.
    expect(suppressionTier(1, 0)).toBe('demote');
    expect(suppressionTier(2, 0)).toBe('demote');
    expect(suppressionTier(3, 0)).toBe('demote');
    // 4+ consistent dismissals: 95%-confident the majority is "dismiss" → suppress.
    expect(suppressionTier(4, 0)).toBe('suppress');
    expect(suppressionTier(10, 0)).toBe('suppress');
  });

  it('a correction (accept/fix) pulls it back out of suppression', () => {
    expect(suppressionTier(4, 0)).toBe('suppress');
    expect(suppressionTier(4, 1)).not.toBe('suppress'); // the user acted on one → no longer 95%-sure
  });

  it('a minority of dismissals does nothing', () => {
    expect(suppressionTier(2, 8)).toBe('none'); // mostly accepted → keep surfacing
  });

  it('no dispositions ⇒ none', () => {
    expect(suppressionTier(0, 0)).toBe('none');
  });
});

describe('recencyWeight (exponential half-life decay)', () => {
  it('is 1 at age 0, halves every half-life, and clamps negative ages to full weight', () => {
    expect(recencyWeight(0, 30)).toBe(1);
    expect(recencyWeight(30, 30)).toBeCloseTo(0.5, 10);
    expect(recencyWeight(60, 30)).toBeCloseTo(0.25, 10);
    expect(recencyWeight(-5, 30)).toBe(1); // future-dated → full weight, never > 1
  });
  it('a non-finite half-life means "never decays" (durable)', () => {
    expect(recencyWeight(10_000, Infinity)).toBe(1);
  });
  it('a non-positive half-life degrades to no-decay (never NaN, never inverts)', () => {
    // A misconfigured `config.suppression` half-life must not silently disable or over-apply
    // suppression. hl=0 would give 0.5^Infinity=0 (age>0) or 0.5^NaN=NaN (age 0); hl<0 would
    // INVERT decay (0.5^negative > 1, growing with age). Both clamp to full weight 1 instead.
    expect(recencyWeight(10, 0)).toBe(1); // would be 0.5^Infinity = 0
    expect(recencyWeight(0, 0)).toBe(1); // would be 0.5^NaN = NaN
    expect(recencyWeight(10, -30)).toBe(1); // would be 0.5^-0.33 ≈ 1.26 (amplifies)
    expect(recencyWeight(60, -30)).toBe(1); // would be 0.5^-2 = 4 (grows with age)
    expect(Number.isNaN(recencyWeight(0, 0))).toBe(false);
  });
});

describe('decayedCounts', () => {
  const hl = { rejectDays: 30, waiveDays: 365 };
  it('fresh dismissals contribute full weight; corrections are durable (undecayed count)', () => {
    const d: Dismissal[] = [{ verb: 'reject', ageDays: 0 }, { verb: 'reject', ageDays: 0 }];
    expect(decayedCounts(d, 3, hl)).toEqual({ dismissals: 2, corrections: 3 });
  });
  it('a waive decays far slower than a reject of the same age', () => {
    const reject = decayedCounts([{ verb: 'reject', ageDays: 365 }], 0, hl).dismissals;
    const waive = decayedCounts([{ verb: 'waive', ageDays: 365 }], 0, hl).dismissals;
    expect(waive).toBeCloseTo(0.5, 10); // one half-life
    expect(reject).toBeLessThan(0.001); // ~12 half-lives
    expect(waive).toBeGreaterThan(reject);
  });
});

describe('decay + suppressionTier (the keystone — C1 survives decay, suppression self-resurfaces)', () => {
  const hl = { rejectDays: 30, waiveDays: 365 };
  const tierAt = (dismissals: Dismissal[]) => {
    const c = decayedCounts(dismissals, 0, hl);
    return suppressionTier(c.dismissals, c.corrections);
  };
  it('one FRESH reject never suppresses — C1 holds even with decay off (age 0)', () => {
    expect(tierAt([{ verb: 'reject', ageDays: 0 }])).not.toBe('suppress');
  });
  it('4 fresh rejects suppress; the same rejects aged out slide back to demote → none', () => {
    const fresh: Dismissal[] = Array.from({ length: 4 }, () => ({ verb: 'reject', ageDays: 0 }));
    expect(tierAt(fresh)).toBe('suppress');
    // After one half-life each weight ≈ 0.5 → effective ~2 dismissals → demote.
    expect(tierAt(fresh.map((d) => ({ ...d, ageDays: 30 })))).toBe('demote');
    // Long stale → effective ~0 → surfaces again (re-surface, no probe).
    expect(tierAt(fresh.map((d) => ({ ...d, ageDays: 365 })))).toBe('none');
  });
  it('waives persist where rejects of the same age have already faded', () => {
    const aged = (verb: 'reject' | 'waive'): Dismissal[] => Array.from({ length: 5 }, () => ({ verb, ageDays: 30 }));
    expect(tierAt(aged('waive'))).toBe('suppress'); // 30d ≪ 365d half-life → barely decayed
    expect(tierAt(aged('reject'))).not.toBe('suppress'); // 30d = one reject half-life → faded to demote
  });
});
