import { describe, it, expect } from 'vitest';
import { isTransientSpawnError, retryTransientSpawn } from './spawn-retry';

// The retry-vs-rethrow decision both @plex/ingest (runGit) and @plex/code-graph (headSha) depend on:
// retry a SPAWN failure (the child never forked — string errno) but never a non-zero EXIT (numeric code
// = a real command failure). Audit #1: code-graph's headSha was an un-retried twin; it now routes here.
describe('isTransientSpawnError', () => {
  it('is true for fork/exec resource errnos (the child could not be forked)', () => {
    for (const code of ['EAGAIN', 'ENOMEM', 'ENFILE', 'EMFILE', 'ETXTBSY']) {
      expect(isTransientSpawnError(Object.assign(new Error('spawn git'), { code }))).toBe(true);
    }
  });
  it('is false for a non-zero exit (code is a NUMBER — a real failure like a bad ref)', () => {
    expect(isTransientSpawnError(Object.assign(new Error('bad ref'), { code: 128 }))).toBe(false);
    expect(isTransientSpawnError(Object.assign(new Error('exit 1'), { code: 1 }))).toBe(false);
  });
  it('is false for a non-error / unknown code', () => {
    expect(isTransientSpawnError(null)).toBe(false);
    expect(isTransientSpawnError(new Error('boom'))).toBe(false);
    expect(isTransientSpawnError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false); // missing bin ≠ retry
    expect(isTransientSpawnError(Object.assign(new Error('x'), { code: 'ESRCH' }))).toBe(false); // signal to dead pid ≠ failed fork
  });
});

describe('retryTransientSpawn', () => {
  const transient = (code: string): Error => Object.assign(new Error('spawn'), { code });

  it('returns the result without retrying on first success', async () => {
    let calls = 0;
    const out = await retryTransientSpawn(async () => { calls++; return 'ok'; });
    expect(out).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries a transient spawn failure, then succeeds', async () => {
    let calls = 0;
    const out = await retryTransientSpawn(
      async () => { calls++; if (calls < 3) throw transient('EAGAIN'); return 'recovered'; },
      { baseMs: 0 },
    );
    expect(out).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('rethrows a non-zero exit IMMEDIATELY — no retry masks a real failure', async () => {
    let calls = 0;
    await expect(
      retryTransientSpawn(async () => { calls++; throw Object.assign(new Error('bad ref'), { code: 128 }); }, { baseMs: 0 }),
    ).rejects.toThrow('bad ref');
    expect(calls).toBe(1); // not retried
  });

  it('gives up after `attempts` transient failures and rethrows the last error', async () => {
    let calls = 0;
    await expect(
      retryTransientSpawn(async () => { calls++; throw transient('EMFILE'); }, { attempts: 4, baseMs: 0 }),
    ).rejects.toThrow('spawn');
    expect(calls).toBe(4); // first try + 3 retries
  });
});
