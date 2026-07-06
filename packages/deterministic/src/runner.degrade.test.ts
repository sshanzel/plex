import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDiff } from '@plex/core';

// Simulate an unavailable Python runtime: tryInitPython reports false, everything else stays real.
vi.mock('@plex/lang-python', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@plex/lang-python')>();
  return { ...mod, tryInitPython: vi.fn().mockResolvedValue(false) };
});

import { runDeterministic } from './runner';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'plex-det-degrade-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/a.ts'), "console.log('debug');\n");
  writeFileSync(join(repo, 'src/tool.py'), 'print("debug")\n');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('runDeterministic when the wasm parser is unavailable', () => {
  it('degrades to TS-only: .py files are skipped, TS findings still flow', async () => {
    const diff: NormalizedDiff = {
      baseRef: 'main',
      files: [
        { path: 'src/a.ts', status: 'modified', hunks: [] },
        { path: 'src/tool.py', status: 'modified', hunks: [] },
      ],
    };
    const rules = (await runDeterministic(repo, diff)).map((f) => f.tags?.[0]);
    expect(rules).toContain('no-console');
    expect(rules).not.toContain('no-print');
  });
});
