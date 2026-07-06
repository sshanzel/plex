import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguagePlugin } from '@plex/core';
import { extractAndResolve } from './build';

// Pure-fs pins for the degradation contracts (no Kùzu — ADR-17): a failed language runtime skips
// ITS files and is reported; one pathological file never aborts the batch (the uniqueSymbolId spirit).

const okPlugin: LanguagePlugin = {
  id: 'ok',
  exts: ['.ok'],
  extract: (file) => ({ imports: [], symbols: [{ name: `sym_${file}`, kind: 'function', startLine: 1, endLine: 1, exported: true }] }),
  resolve: () => ({ imports: [], refs: [] }),
};
const brokenRuntime: LanguagePlugin = {
  id: 'boom',
  exts: ['.bx'],
  init: () => Promise.reject(new Error('wasm failed to load')),
  extract: () => ({ imports: [], symbols: [] }),
  resolve: () => ({ imports: [], refs: [] }),
};
const throwyExtract: LanguagePlugin = {
  id: 'throwy',
  exts: ['.tx'],
  extract: (file) => {
    if (file.includes('bad')) throw new Error('pathological file');
    return { imports: [], symbols: [{ name: 'fine', kind: 'function', startLine: 1, endLine: 1, exported: true }] };
  },
  resolve: () => ({ imports: [], refs: [] }),
};

const byExt =
  (...plugins: LanguagePlugin[]) =>
  (file: string): LanguagePlugin | undefined =>
    plugins.find((p) => p.exts.some((e) => file.endsWith(e)));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plex-extract-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const setup = (rels: string[]) => {
  const absByRel = new Map<string, string>();
  for (const rel of rels) {
    const abs = join(dir, rel);
    writeFileSync(abs, 'content\n');
    absByRel.set(rel, abs);
  }
  return { absByRel, fileSet: new Set(rels) };
};

describe('extractAndResolve degradation', () => {
  it('a failed language runtime skips ITS files, reports the language, and never touches the healthy one', async () => {
    const { absByRel, fileSet } = setup(['a.ok', 'b.bx', 'c.bx']);
    const batch = await extractAndResolve(dir, ['a.ok', 'b.bx', 'c.bx'], absByRel, fileSet, false, byExt(okPlugin, brokenRuntime));
    expect(batch.skippedLanguages).toEqual(['boom']);
    expect(batch.symbolRows.map((r) => r.name)).toEqual(['sym_a.ok']);
  });

  it('a healthy build reports no skipped languages', async () => {
    const { absByRel, fileSet } = setup(['a.ok']);
    const batch = await extractAndResolve(dir, ['a.ok'], absByRel, fileSet, false, byExt(okPlugin));
    expect(batch.skippedLanguages).toEqual([]);
  });

  it('one pathological file never aborts the batch — siblings still extract', async () => {
    const { absByRel, fileSet } = setup(['bad.tx', 'good.tx']);
    const batch = await extractAndResolve(dir, ['bad.tx', 'good.tx'], absByRel, fileSet, false, byExt(throwyExtract));
    expect(batch.symbolRows.map((r) => r.name)).toEqual(['fine']);
    expect(batch.skippedLanguages).toEqual([]); // a per-file throw is NOT a language failure
  });

  it('an unreadable file is skipped the same way (existing guard preserved)', async () => {
    const { absByRel, fileSet } = setup(['good.tx']);
    absByRel.set('ghost.tx', join(dir, 'missing.tx')); // never written
    const batch = await extractAndResolve(dir, ['ghost.tx', 'good.tx'], absByRel, fileSet, false, byExt(throwyExtract));
    expect(batch.symbolRows.map((r) => r.name)).toEqual(['fine']);
  });
});
