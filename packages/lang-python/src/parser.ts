import { createRequire } from 'node:module';
import { Parser, Language, type Tree } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | undefined;
let parser: Parser | undefined;

/**
 * One-time wasm setup (web-tree-sitter runtime + the tree-sitter-python grammar, ADR-52) — idempotent
 * and lazy, so TS-only repos never pay the load. The grammar wasm ships inside the tree-sitter-python
 * npm package (no native build; its blocked node-gyp-build install script is irrelevant to the wasm).
 */
export function initPython(): Promise<void> {
  initPromise ??= (async () => {
    await Parser.init();
    const lang = await Language.load(require.resolve('tree-sitter-python/tree-sitter-python.wasm'));
    const p = new Parser();
    p.setLanguage(lang);
    parser = p;
  })();
  return initPromise;
}

/**
 * Parse one Python source — sync after `initPython()`. The caller MUST `tree.delete()` (in a
 * `finally`): Emscripten heap memory is not GC'd, and leaking trees across a whole-repo index
 * balloons the process.
 */
export function parsePython(text: string): Tree {
  if (!parser) throw new Error('Python parser not initialized — await initPython() first');
  const tree = parser.parse(text);
  if (!tree) throw new Error('Python parse returned no tree');
  return tree;
}
