# @plex/lang-python

The **Python language plugin** (ADR-52/M15): tree-sitter **WASM** parsing (never a second native
addon beside Kùzu — ADR-16/17 pain), structural extraction, and fileSet-pure module resolution.
Consumed by `@plex/code-graph` (graph build, via `pythonPlugin`) and `@plex/deterministic`
(`analyzePySource` walks trees from `parsePython`). Kùzu-free by design so deterministic stays
vitest-safe. Deep detail: [`docs/design/python-support.md`](../../docs/design/python-support.md).

## Module map

- `src/parser.ts` — the ONE parser singleton: `initPython()` (lazy, idempotent; loads
  `tree-sitter-python.wasm` via `createRequire` — works from dev/tsx, `dist/`, and npx installs)
  + sync `parsePython(text)`. **Callers must `tree.delete()` in a `finally`** — Emscripten heap
  is not GC'd; leaking trees across a whole-repo index balloons the process.
- `src/extract-py.ts` — `extractPythonSource` → `ExtractedFile` (the `@plex/core` seam):
  functions/classes/`Class.method` (innermost class, TS parity), decorated spans start at the
  first decorator, module-level `NAME = lambda` → `const`, PEP 695 `type` aliases; `exported` =
  literal `__all__` membership else `!_`-prefix, methods inherit the class flag. Import
  specifiers keep Python's own dotted form, leading dots preserved (`.x`, `..pkg.y`); star,
  TYPE_CHECKING, try-fallback, function-scoped, and literal-only dynamic imports all captured.
- `src/resolve-py.ts` — pure `buildModuleIndex(fileSet, extraRoots?)` (roots = repo root ∪ `src/`
  segments ∪ walk-up-while-`__init__.py` package parents) + `resolvePythonImport` (deepest-first
  walk-down; `__init__.py` is the index-file analog; submodule file beats `__init__` symbol;
  deterministic tie-breaks). Only fileSet members can resolve → a bad guess is impossible, only
  a missing edge.
- `src/index.ts` — barrel + `pythonPlugin: LanguagePlugin` (`resolve` returns
  `{ imports, refs: [] }` — **Refs stays TS-only**, ADR-06/52).

## Invariants & gotchas

- `extract`/`analyze` are sync and PURE after `initPython()` — the async-ness lives at the
  callers' edges (build loop / deterministic runner), per the root "pure core, impure edges" rule.
- The **symbol-naming contract** with `@plex/deterministic`'s Python `enclosingSymbol` is
  load-bearing (ADR-47/48 keys): dotted `Class.method`, nested defs plain. Cross-pinned by tests
  in both packages — change them together or not at all.
- Never descend into `ERROR` nodes when extracting (tree-sitter recovers broken files; a
  recovered `function_definition` with an ERROR inside its params is still real and IS extracted).
- `web-tree-sitter` + `tree-sitter-python` must stay `external` in `tsup.config.ts` and declared
  in the ROOT package.json (the bundle resolves them from node_modules; bundling breaks the
  Emscripten wasm lookup). Neither needs `pnpm.onlyBuiltDependencies` — the wasm ships in the
  tarball; the blocked `node-gyp-build` script only builds the native binding nobody requires.

## Testing

All pure vitest (`pnpm test:unit`): `parser.test.ts` (init/idempotency/error-tolerance — doubles
as the wasm-under-vitest teardown canary), `extract-py.test.ts`, `resolve-py.test.ts`. The graph
integration lives in `packages/engine/integration.mts` (`py-graph`, `py-incremental`, `py-mixed`);
the shipped-runtime packaging check is `scripts/py-check.mjs` (`pnpm test:py`).
