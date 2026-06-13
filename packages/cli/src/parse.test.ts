import { describe, it, expect } from 'vitest';
import { parse, finiteFlag, FlagError } from './parse';

// The CLI arg parser. Pinned after `--flag=value` was found to be silently mis-parsed
// (the whole `flag=value` became a boolean key, so e.g. `--branch=main` set no base ref).
describe('parse', () => {
  it('parses `--flag value`', () => {
    expect(parse(['--branch', 'main']).flags).toEqual({ branch: 'main' });
  });

  it('parses `--flag=value` (the previously-broken form)', () => {
    expect(parse(['--branch=main']).flags).toEqual({ branch: 'main' });
    expect(parse(['--base=origin/main']).flags).toEqual({ base: 'origin/main' });
  });

  it('keeps an explicit empty value for `--flag=`', () => {
    expect(parse(['--note=']).flags).toEqual({ note: '' });
  });

  it('treats a bare `--flag` (or one followed by another flag) as boolean true', () => {
    expect(parse(['--json']).flags).toEqual({ json: true });
    expect(parse(['--staged', '--json']).flags).toEqual({ staged: true, json: true });
  });

  it('collects positionals and mixes them with flags', () => {
    const { positionals, flags } = parse(['index', '/repo', '--staged']);
    expect(positionals).toEqual(['index', '/repo']);
    expect(flags).toEqual({ staged: true });
  });

  it('accepts a negative-number value (single dash is not a flag)', () => {
    expect(parse(['--limit', '-5']).flags).toEqual({ limit: '-5' });
  });

  it('last value wins for a repeated flag', () => {
    expect(parse(['--m', 'a', '--m', 'b']).flags).toEqual({ m: 'b' });
  });

  it('handles a realistic review invocation', () => {
    const { positionals, flags } = parse(['review', '/r', '--pr', '42', '--json']);
    expect(positionals).toEqual(['review', '/r']);
    expect(flags).toEqual({ pr: '42', json: true });
  });
});

// #3 silent-failure audit: a non-numeric numeric-flag value used to coerce to NaN and flow silently
// into the engine (slice(0, NaN) = 0 PRs, clusterThreshold = NaN = 0 pitfalls), exiting 0 having done
// nothing. finiteFlag turns that into a loud FlagError the run() edge maps to a non-zero exit.
describe('finiteFlag', () => {
  it('parses a valid number (int, float, negative)', () => {
    expect(finiteFlag('42', 'limit')).toBe(42);
    expect(finiteFlag('0.8', 'threshold')).toBe(0.8);
    expect(finiteFlag('-5', 'limit')).toBe(-5);
  });
  it('throws FlagError on a non-numeric value (the NaN trap)', () => {
    expect(() => finiteFlag('abc', 'threshold')).toThrow(FlagError);
    expect(() => finiteFlag('abc', 'threshold')).toThrow('--threshold must be a finite number (got "abc")');
  });
  it('throws on empty, Infinity, and other non-finite values', () => {
    expect(() => finiteFlag('', 'limit')).toThrow(FlagError); // Number('') === 0 is finite, but blank is a user error
    expect(() => finiteFlag('Infinity', 'limit')).toThrow(FlagError);
    expect(() => finiteFlag('NaN', 'min-cluster')).toThrow(FlagError);
  });
});
