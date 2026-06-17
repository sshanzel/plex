import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveConfig, type RankedFinding } from '@plex/core';
import { Brain } from './brain';
import { lineagePaths } from './paths';

// The brain is now durable JSONL (ADR-46) — no Kùzu — so it's unit-testable here. These pin the
// fold contract + the Plex-review robustness fixes (#1 ENOENT distinction, #2 concurrent-append lock).
const config = resolveConfig({ dataDir: '.plex' });
const finding = (over: Partial<RankedFinding> = {}): RankedFinding =>
  ({ title: 'leak', body: '', severity: 'bug', confidence: 0.6, source: 'first-principles', location: { repo: 'r', file: 'a.ts', startLine: 5, endLine: 5 }, signal: 0.4, agreedSources: ['first-principles'], triage: 'surface', ...over }) as RankedFinding;

describe('Brain (durable JSONL lineage)', () => {
  let dir: string;
  let brain: Brain;
  const target = 'r__staged';
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'plex-brain-unit-'));
    brain = await Brain.open(dir, config);
  });
  afterEach(async () => {
    await brain.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a target with no file → empty round state', async () => {
    const st = await brain.loadRoundState(target);
    expect(st).toMatchObject({ lastN: 0, rounds: [], priorFindings: [] });
  });

  it('round-trips rounds/findings; outcome is sticky across a re-raise (ADR-28)', async () => {
    await brain.recordRound(target, { target, n: 1, ts: 't1', headSha: 'sha1', baseRef: 'main' }, [
      { id: 'c1', body: 'looks off', file: 'a.ts', line: 6 },
    ]);
    await brain.writeFindings(target, 1, [finding()]);

    let st = await brain.loadRoundState(target);
    expect(st).toMatchObject({ lastN: 1, lastHeadSha: 'sha1' });
    expect(st.priorFindings).toHaveLength(1); // un-outcomed
    const fid = st.priorFindings[0]!.id;
    expect(st.signals.some((s) => s.label.startsWith('comment:'))).toBe(true);

    await brain.markFindingOutcome(fid, 'fixed');
    st = await brain.loadRoundState(target);
    expect(st.priorFindings).toHaveLength(0); // dispositioned → out of the fix-inference pool

    // Re-raise the SAME finding (re-review) — must NOT resurrect it (outcome stays 'fixed').
    await brain.writeFindings(target, 2, [finding()]);
    st = await brain.loadRoundState(target);
    expect(st.priorFindings).toHaveLength(0);
  });

  it('carries the symbol key through writeFindings → loadRoundState (code-path memory, ADR-47)', async () => {
    await brain.writeFindings(target, 1, [finding({ location: { repo: 'r', file: 'a.ts', startLine: 5, endLine: 9, symbol: 'leakyFn' } })]);
    const st = await brain.loadRoundState(target);
    expect(st.priorFindings[0]!.symbol).toBe('a.ts#leakyFn'); // the accept path reads this to anchor its incident
  });

  it('#1: a genuine read fault surfaces — it does NOT masquerade as empty history', async () => {
    // Put a DIRECTORY where the target's .jsonl file should be → readFileSync throws EISDIR.
    const file = lineagePaths(dir, config.dataDir).fileFor(target);
    mkdirSync(file, { recursive: true });
    await expect(brain.loadRoundState(target)).rejects.toThrow();
  });

  it('#2: a stale append lock is reclaimed, the round still records, and the lock is released', async () => {
    const lock = `${lineagePaths(dir, config.dataDir).fileFor(target)}.lock`;
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 10_000); // >2s → stale
    utimesSync(lock, old, old);

    await brain.recordRound(target, { target, n: 1, ts: 't', headSha: 's', baseRef: 'main' }, []);
    const st = await brain.loadRoundState(target);
    expect(st.lastN).toBe(1); // appended despite the (stale) lock
    expect(existsSync(lock)).toBe(false); // released after the append
  });
});
