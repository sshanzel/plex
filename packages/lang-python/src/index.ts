import type { ImportEdge, LanguagePlugin } from '@plex/core';
import { initPython, parsePython } from './parser';
import { extractPythonSource } from './extract-py';
import { buildModuleIndex, resolvePythonImport } from './resolve-py';

export { initPython, tryInitPython, parsePython } from './parser';
export { extractPythonSource } from './extract-py';
export { buildModuleIndex, resolvePythonImport, type PyModuleIndex } from './resolve-py';
// Consumers walk parsed trees without depending on web-tree-sitter themselves.
export type { Node, Tree } from 'web-tree-sitter';

/**
 * Python behind the seam (ADR-52): tree-sitter extraction + fileSet-derived module resolution →
 * `Imports` edges only. `refs` stays empty — Refs is the config-aware enrichment layer (ADR-06),
 * and Python v1's resolver IS the base structural layer; a future pyproject-aware pass becomes Refs.
 */
export const pythonPlugin: LanguagePlugin = {
  id: 'py',
  exts: ['.py'],
  init: initPython,
  extract: extractPythonSource,
  resolve(_repoPath, units, fileSet, opts) {
    const index = buildModuleIndex(fileSet, opts?.extraRoots ?? []);
    const imports: ImportEdge[] = [];
    const seen = new Set<string>();
    for (const u of units) {
      for (const spec of u.imports) {
        const to = resolvePythonImport(u.rel, spec, index, fileSet);
        if (to && to !== u.rel && !seen.has(`${u.rel}\t${to}`)) {
          seen.add(`${u.rel}\t${to}`);
          imports.push({ from: u.rel, to });
        }
      }
    }
    return { imports, refs: [] };
  },
};
