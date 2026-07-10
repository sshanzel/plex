import { describe, expect, it } from 'vitest';
import { languageOf } from '@plex/core';
import { pluginFor, isSupportedSource } from './languages';

describe('language dispatch — the graph and deterministic gates must agree', () => {
  it('maps extensions to plugins, case-insensitively (like languageOf)', () => {
    expect(pluginFor('src/a.ts')?.id).toBe('ts');
    expect(pluginFor('src/b.py')?.id).toBe('py');
    expect(pluginFor('src/c.PY')?.id).toBe('py');
    expect(pluginFor('src/d.TS')?.id).toBe('ts');
    expect(pluginFor('src/e.txt')).toBeUndefined();
    expect(pluginFor('src/f.pyi')).toBeUndefined(); // the .d.ts analog stays excluded
  });

  it('never disagrees with the deterministic gate on plugin-owned languages', () => {
    for (const f of ['a.ts', 'a.TS', 'b.py', 'b.PY', 'c.jsx', 'd.mjs']) {
      const lang = languageOf(f);
      expect(isSupportedSource(f), f).toBe(lang === 'ts' || lang === 'py');
    }
  });
});
