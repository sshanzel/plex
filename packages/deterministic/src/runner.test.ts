import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
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

  it('never reads a path that escapes the repo root (hostile-diff containment)', async () => {
    // A malicious PR diff can carry a traversal path. Plant a real, parseable source file just
    // outside the repo; the runner must NOT read it even though it exists and is a supported ext.
    const outside = mkdtempSync(join(tmpdir(), 'plex-outside-'));
    try {
      writeFileSync(join(outside, 'secret.ts'), SRC); // would yield a no-console finding if read
      // repo and outside share the same tmpdir parent, so this traversal resolves INTO outside.
      const traversal = `../${outside.split('/').pop()}/secret.ts`;
      expect(await runDeterministic(repo, diff(file({ path: traversal, hunks: [] })))).toEqual([]);
      // a classic deep escape is contained too.
      expect(await runDeterministic(repo, diff(file({ path: '../../../../etc/passwd.ts', hunks: [] })))).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never reads through an in-tree symlink that points outside the repo (realpath containment)', async () => {
    // Lexical resolution alone wouldn't catch this: `link/secret.ts` resolves lexically INSIDE the
    // repo, but `link` is a symlink to an outside dir, so a plain readFile would follow it out.
    const outside = mkdtempSync(join(tmpdir(), 'plex-outside-'));
    try {
      writeFileSync(join(outside, 'secret.ts'), SRC);
      symlinkSync(outside, join(repo, 'link')); // a symlink planted in the reviewed tree
      expect(await runDeterministic(repo, diff(file({ path: 'link/secret.ts', hunks: [] })))).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('uses repoName override, else the repo basename', async () => {
    const named = await runDeterministic(repo, diff(file()), { repoName: 'myrepo' });
    expect(named[0]!.location.repo).toBe('myrepo');
    const def = await runDeterministic(repo, diff(file()));
    expect(def[0]!.location.repo).toBe(join(repo).split('/').pop());
  });

  it('stamps MEASURED rule prevalence: fraction of sampled files with a hit (ADR-05)', async () => {
    // 4 source files, 2 of them console-logging → no-console prevalence 0.5.
    writeFileSync(join(repo, 'src/b.ts'), "console.log('more debug');\n");
    writeFileSync(join(repo, 'src/c.ts'), 'export const clean = 1;\n');
    writeFileSync(join(repo, 'src/d.ts'), 'export const alsoClean = 2;\n');
    const out = await runDeterministic(repo, diff(file()));
    expect(out[0]!.prevalence).toBeCloseTo(0.5, 5);
  });

  it('skips the prevalence scan when disabled', async () => {
    const out = await runDeterministic(repo, diff(file()), { rulePrevalence: false });
    expect(out[0]!.prevalence).toBeUndefined();
  });
});
