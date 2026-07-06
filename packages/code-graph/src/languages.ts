import path from 'node:path';
import type { ImportEdge, LanguagePlugin } from '@plex/core';
import { pythonPlugin } from '@plex/lang-python';
import { extractFromSource, resolveRelativeImport, TS_EXTS } from './extract-ts';
import { resolvePreciseImports } from './precise';

/** TS/JS behind the seam (ADR-15): structural extraction + relative resolver → Imports, tsconfig-aware precise pass → Refs. */
export const tsPlugin: LanguagePlugin = {
  id: 'ts',
  exts: TS_EXTS,
  extract: extractFromSource,
  resolve(repoPath, units, fileSet, opts) {
    const imports: ImportEdge[] = [];
    const seen = new Set<string>();
    for (const u of units) {
      for (const spec of u.imports) {
        const to = resolveRelativeImport(u.rel, spec, fileSet);
        if (to && to !== u.rel && !seen.has(`${u.rel}\t${to}`)) {
          seen.add(`${u.rel}\t${to}`);
          imports.push({ from: u.rel, to });
        }
      }
    }
    const refs =
      opts?.refs === false
        ? []
        : resolvePreciseImports(
            repoPath,
            units.map((u) => ({ rel: u.rel, abs: u.abs, specifiers: u.imports })),
            fileSet,
          ).filter((e) => !seen.has(`${e.from}\t${e.to}`));
    return { imports, refs };
  },
};

export const PLUGINS: readonly LanguagePlugin[] = [tsPlugin, pythonPlugin];

const PLUGIN_BY_EXT = new Map(PLUGINS.flatMap((p) => p.exts.map((e) => [e, p] as const)));

export function pluginFor(file: string): LanguagePlugin | undefined {
  return PLUGIN_BY_EXT.get(path.extname(file));
}

/** The indexable-file allowlist: the union of every registered plugin's extensions. */
export function isSupportedSource(file: string): boolean {
  return PLUGIN_BY_EXT.has(path.extname(file));
}
