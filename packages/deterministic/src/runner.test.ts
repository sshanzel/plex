import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDiff, DiffFile } from '@plex/core';
import { runDeterministic } from './runner';

// runner.ts reads files + scopes builtin findings to changed lines. Pure fs (no Kùzu) →
// vitest-safe. The load-bearing contract: findings are emitted only on changed ranges,
// EXCEPT when a file has no captured ranges (new file) — then all are emitted.
let repo: string;
// line 1: clean, line 2: a no-console finding.
const SRC = "export const ok = 1;\nconsole.log('debug');\n";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'plex-det-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/a.ts'), SRC);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const file = (over: Partial<DiffFile> = {}): DiffFile => ({
  path: 'src/a.ts',
  status: 'modified',
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, newRanges: [{ start: 2, end: 2 }] }],
  ...over,
});
const diff = (f: DiffFile): NormalizedDiff => ({ baseRef: 'main', files: [f] });

describe('runDeterministic', () => {
  it('emits a finding on a changed line', async () => {
    const out = await runDeterministic(repo, diff(file()));
    expect(out.map((x) => x.tags?.[0])).toContain('no-console');
    expect(out[0]!.location.startLine).toBe(2);
  });

  it('suppresses a finding outside the changed ranges (onlyChangedRanges default)', async () => {
    const out = await runDeterministic(repo, diff(file({ hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, newRanges: [{ start: 1, end: 1 }] }] })));
    expect(out).toEqual([]);
  });

  it('emits regardless of overlap when onlyChangedRanges is false', async () => {
    const f = file({ hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, newRanges: [{ start: 1, end: 1 }] }] });
    const out = await runDeterministic(repo, diff(f), { onlyChangedRanges: false });
    expect(out).toHaveLength(1);
  });

  it('emits ALL findings when the file has no captured ranges (new file)', async () => {
    // ranges.length === 0 short-circuits the changed-range filter — review the whole file.
    const out = await runDeterministic(repo, diff(file({ status: 'added', hunks: [] })));
    expect(out).toHaveLength(1);
  });

  it('skips deleted files, unsupported extensions, and files missing on disk', async () => {
    expect(await runDeterministic(repo, diff(file({ status: 'deleted' })))).toEqual([]);
    writeFileSync(join(repo, 'src/a.txt'), SRC);
    expect(await runDeterministic(repo, diff(file({ path: 'src/a.txt' })))).toEqual([]);
    expect(await runDeterministic(repo, diff(file({ path: 'src/ghost.ts' })))).toEqual([]);
  });

  it('uses repoName override, else the repo basename', async () => {
    const named = await runDeterministic(repo, diff(file()), { repoName: 'myrepo' });
    expect(named[0]!.location.repo).toBe('myrepo');
    const def = await runDeterministic(repo, diff(file()));
    expect(def[0]!.location.repo).toBe(join(repo).split('/').pop());
  });
});
