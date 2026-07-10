import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDiff } from '@plex/core';

// One pathological file whose ANALYZER throws (wasm memory exhaustion, a parser bug) must never
// abort the whole run — the per-file guard's contract, mirroring extractAndResolve's on the graph side.
vi.mock('./analyze', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./analyze')>();
  return {
    ...mod,
    analyzerFor: (file: string) => {
      const real = mod.analyzerFor(file);
      if (!real) return undefined;
      return file.includes('poison')
        ? () => {
            throw new Error('analyzer blew up');
          }
        : real;
    },
  };
});

import { runDeterministic } from './runner';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'plex-det-guard-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/poison.ts'), 'export const x = 1;\n');
  writeFileSync(join(repo, 'src/fine.ts'), "console.log('debug');\n");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('runDeterministic per-file analyzer guard', () => {
  it('a throwing file is skipped; siblings (diff loop AND prevalence sample) still analyze', async () => {
    const diff: NormalizedDiff = {
      baseRef: 'main',
      files: [
        { path: 'src/poison.ts', status: 'modified', hunks: [] },
        { path: 'src/fine.ts', status: 'modified', hunks: [] },
      ],
    };
    const out = await runDeterministic(repo, diff); // prevalence scan runs too — poison.ts is in its sample
    expect(out.map((f) => f.tags?.[0])).toContain('no-console');
    expect(out.every((f) => f.location.file === 'src/fine.ts')).toBe(true);
  });
});
