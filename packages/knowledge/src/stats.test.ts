import { describe, it, expect } from 'vitest';
import { betaPosteriorMean, wilsonLowerBound, suppressionTier } from './stats';

describe('betaPosteriorMean', () => {
  it('is α/(α+β)', () => {
    expect(betaPosteriorMean(1, 1)).toBe(0.5); // uniform prior, no evidence
    expect(betaPosteriorMean(3, 1)).toBe(0.75); // 2 accepts under Beta(1,1)
    expect(betaPosteriorMean(1, 2.5)).toBeCloseTo(0.2857, 4); // 1 reject at cost 1.5
  });
  it('guards the empty case', () => {
    expect(betaPosteriorMean(0, 0)).toBe(0);
  });
});

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
