import { describe, it, expect } from 'vitest';
import { RepoBusyError, isLockError } from './errors';

describe('isLockError', () => {
  it('matches the Kùzu file-lock IOException (empirically-confirmed wording)', () => {
    const e = new Error(
      'IO exception: Could not set lock on file : /home/u/.plex/repos/x/brain.kuzu\n' +
        'See the docs: https://docs.kuzudb.com/concurrency for more information.',
    );
    expect(isLockError(e)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isLockError(new Error('could not set LOCK on file : /x'))).toBe(true);
  });

  it('does NOT match unrelated errors — never mask a real failure as "busy"', () => {
    expect(isLockError(new Error('IO exception: file not found'))).toBe(false);
    expect(isLockError(new Error('Parser exception: syntax error'))).toBe(false);
    expect(isLockError('not an error object')).toBe(false);
    expect(isLockError(undefined)).toBe(false);
  });
});

describe('RepoBusyError', () => {
  it('is a named Error carrying the dir and an actionable message', () => {
    const err = new RepoBusyError('/home/u/.plex/repos/x/brain.kuzu');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RepoBusyError');
    expect(err.dir).toBe('/home/u/.plex/repos/x/brain.kuzu');
    expect(err.message).toContain('another process');
    expect(err.message).toContain('worktrees run in parallel'); // the reassurance that parallelism is fine
  });
});
