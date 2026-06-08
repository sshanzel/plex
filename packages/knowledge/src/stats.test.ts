import { describe, it, expect } from 'vitest';
import { betaPosteriorMean, wilsonLowerBound } from './stats';

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
