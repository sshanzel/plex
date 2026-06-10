import { describe, it, expect } from 'vitest';
import { isSubstantive, categorize } from './classify';

// Complements analysis.test.ts with the BOUNDARY and precedence cases that gate ~70% of
// review-comment noise. These contracts are fragile under regex edits, so pin them.
describe('isSubstantive boundaries', () => {
  it('rejects under 15 chars, accepts 15+ with 3+ words', () => {
    expect(isSubstantive('aa bb cccccccc')).toBe(false); // 14 chars
    expect(isSubstantive('aaa bbb cccccccc')).toBe(true); // 16 chars, 3 words
  });

  it('rejects fewer than 3 words even when long (e.g. a bare URL)', () => {
    expect(isSubstantive('https://example.com/a/really/long/path/here')).toBe(false);
  });

  it('treats `nit:` as trivial but `nitpick…` as substantive (anchored \\b distinction)', () => {
    expect(isSubstantive('nit: rename this variable')).toBe(false);
    expect(isSubstantive('nitpick the whole thing here please')).toBe(true);
  });

  it('only suppresses trivial words at the START (lgtm mid-sentence stays substantive)', () => {
    expect(isSubstantive('the code is lgtm overall here today')).toBe(true);
  });

  it('trims before the length check', () => {
    expect(isSubstantive('   short   ')).toBe(false);
  });
});

describe('categorize precedence', () => {
  it('returns general for empty / uncategorizable text', () => {
    expect(categorize('')).toBe('general');
    expect(categorize('just some prose about lunch')).toBe('general');
  });

  it('applies first-match-wins ordering (security before error-handling)', () => {
    expect(categorize('null permission error')).toBe('security'); // permission ⇒ security wins
    expect(categorize('null pointer dereference')).toBe('error-handling'); // no security token
  });

  it('routes representative tokens to their category', () => {
    expect(categorize('this has an n+1 query')).toBe('performance');
    expect(categorize('add a retry with backoff')).toBe('error-handling');
    expect(categorize('there is a race condition here')).toBe('concurrency');
    expect(categorize('the flaky test needs a fixture')).toBe('testing');
  });
});
