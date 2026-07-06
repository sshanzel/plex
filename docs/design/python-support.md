# Python support — design detail (ADR-52 / M15)

How Python plugs in behind the ADR-15 extractor seam. This is the implementation-level companion
to ADR-52; read that first for the decision and its rejected alternatives.

## Parser lifecycle & packaging

- Runtime: **web-tree-sitter (WASM)** + the prebuilt `tree-sitter-python.wasm` shipped inside the
  `tree-sitter-python` npm package (verified: no `exports` map, so any-subpath `require.resolve`
  works; its `node-gyp-build` install script stays blocked by pnpm and is irrelevant — tarball
  extraction delivers the wasm).
- `@plex/lang-python/src/parser.ts` owns the ONE parser singleton: `initPython()` (idempotent,
  memoized promise; `Parser.init()` + `Language.load(createRequire(import.meta.url)
  .resolve('tree-sitter-python/tree-sitter-python.wasm'))`) and sync `parsePython(text)`.
- **Callers must `tree.delete()` in a `finally`** — Emscripten heap memory is not GC'd; leaking
  trees across a whole-repo index balloons the child process. Throughput measured ≈19ms per
  3,900-line file, flat RSS.
- **tsup**: `web-tree-sitter` and `tree-sitter-python` are `external` (root-package runtime deps).
  web-tree-sitter's Emscripten glue locates `web-tree-sitter.wasm` relative to its own module
  file; bundling it would re-anchor `import.meta.url` to `dist/` and break the lookup.
- Init is **lazy per language**: `build.ts` awaits `plugin.init?.()` only when a matching file is
  actually read; the deterministic runner inits only when the diff (or prevalence sample)
  contains `.py`. TS-only repos never pay the wasm load.

## The symbol-naming contract (load-bearing, cross-pinned by tests)

`extract-py` (graph symbols) and the deterministic `enclosingSymbol` MUST agree:

| Shape | Name | Notes |
|---|---|---|
| top-level `def f` | `f` | `exported` = `__all__` membership else `!_`-prefix |
| direct class member `def m` (incl. decorated / `async` / `@property`) | `C.m` | innermost class; inherits the class's exported flag |
| method of a nested class | `Inner.m` | innermost class only |
| def nested in a function/method body | its plain name | TS parity; `exported: false` |
| module-level `NAME = lambda …` | `NAME` | kind `const` (the arrow-fn-initializer mirror) |
| PEP 695 `type X = …` | `X` | kind `type` |
| decorated definition | — | span starts at the FIRST decorator (changed-line attribution) |

The dotted method name deliberately diverges from the TS analyzer's unqualified `enclosingSymbol`:
Python dunders (`__init__` in every class) collide within a file, which would over-broaden ADR-48
symbol-scoped suppression. Dotting also makes deterministic symbols equal graph symbols, so
code-path memory (ADR-47, `file#name` keys) matches across sources. The cross-pin test lives in
`deterministic/src/builtin-py.test.ts` ("CROSS-PIN: …").

## Import extraction → canonical specifiers

Leading dots preserved; one specifier per imported name:

| Source | Specifier(s) |
|---|---|
| `import a.b.c [as x]` | `a.b.c` |
| `from a.b import c as x, d` | `a.b.c`, `a.b.d` |
| `from a.b import *` | `a.b` |
| `from . import x` / `from ..pkg import y` / `from .. import *` | `.x` / `..pkg.y` / `..` |
| `importlib.import_module("a.b")`, `__import__("a.b")` — literal single-string arg only | `a.b` |
| `from __future__ import …` | skipped |

Imports at ANY depth are captured — function-scoped (the circular-import idiom), under
`if TYPE_CHECKING:`, and both arms of `try/except ImportError` are real coupling; out-of-repo
alternatives resolve to nothing and vanish.

## Module index & resolution (fileSet-pure)

No fs reads, no pyproject/setup.cfg parsing. Roots:

```
roots = { '' }                                   // repo root
      ∪ { every directory segment named 'src' }  // src layout
      ∪ { parent of each TOPMOST __init__.py package }   // walk-up-while-__init__-exists
      ∪ extraRoots                               // ResolveOptions seam; unplumbed in v1
```

Each `.py` under a root maps to its dotted path (`__init__` names the package; a root-level
`__init__.py` names nothing). Resolution is a **deepest-first walk-down**:

- **Relative** (`L` dots, tail `t1..tn`): ascend `L−1` dirs from the importer; for `k = n..0` try
  `path/t1..tk + '/__init__.py'` then `+ '.py'` — **package before module**, matching Python's
  finder order when `m/__init__.py` and a sibling `m.py` coexist. Deepest-first still settles
  `from .m import name` (submodule-vs-symbol): `m/name.py` before `m/__init__.py`. Ascending above
  the repo root → null. The importing file itself is never a match.
- **Absolute**: for `k = n..1` look up `index[t1..tk]`; tie-break deterministically by longest
  common directory prefix with the importer (each distributed package sees its own root) →
  package over a same-named module → shortest path → lexicographic. No hit → null (stdlib /
  third-party — exactly like bare specifiers → node_modules in TS).

**Imports only; `Refs` stays TS-only.** Refs is the *config-aware enrichment* layer (ADR-06);
this resolver IS Python's base structural layer. A future pyproject-aware precise pass would emit
Refs. A pure re-export `__init__.py` has no symbols → the existing query-time barrel heuristic
(0 own symbols + import-degree ≥ 3) makes it transparent to the PageRank walk — `__init__.py`
re-export hubs are the barrel-import analog with zero new query logic.

**Failure mode is always a missing edge, never a wrong one** (candidates only ever come from the
fileSet). Deep PEP-420 namespace packages under a non-`src` nested root are the acknowledged gap;
`ResolveOptions.extraRoots` is the pre-built escape hatch (plumb a `python.extraRoots` config only
if dogfooding shows real misses — config is a liability).

## Deterministic rules (7) — and the rejected ones

| Rule | Sev/Conf | Trigger |
|---|---|---|
| `no-breakpoint` | bug/0.95 | `breakpoint()`, `pdb`/`ipdb` `.set_trace()`, `import pdb`/`ipdb`, `from pdb import …` |
| `mutable-default-arg` | bug/0.9 | `default_parameter`/`typed_default_parameter` (incl. lambda params) valued list/dict/set literal, comprehension, or bare `list`/`dict`/`set` call |
| `no-return-in-finally` | bug/0.85 | `return` whose nearest {finally_clause, def, lambda} ancestor is the finally |
| `no-bare-except` | improvement/0.9 | `except:` with no type and a real body |
| `no-silent-except` | improvement/0.85 | except body solely `pass`/`...` — PRIORITY over bare: one finding per clause |
| `use-is-none` | nit/0.9 | `==`/`!=` operator ADJACENT to a `none` operand (`a == b is None` exempt) |
| `no-print` | nit/0.5 | bare `print(...)` — below `no-console`'s 0.6: CLIs print legitimately; measured prevalence demotes it per repo, one `pattern-repo` waiver kills it |

All walks skip `ERROR` subtrees (tree-sitter is error-tolerant; a half-typed file must not emit
phantom findings). Rule ids never overlap TS's (`ruleLanguage` in `analyze.ts`), and prevalence
denominators are per-language (ADR-05: a universal py habit in a 90%-TS monorepo isn't "rare").

**Rejected** (institutional memory — the `no-await-in-loop` lesson: deterministic rules have no
confidence feedback loop, so a noisy rule re-surfaces forever):
- `assert` outside tests — "outside tests" is not syntactically decidable; pytest-helper code
  false-positives.
- f-string SQL / `subprocess(shell=True)` / `eval` security lints — need taint context for
  precision; ADR-37's posture is defer-to-your-linter (Bandit/Semgrep).
- `except Exception: pass` as its own rule — covered by `no-silent-except`.
- `x is "literal"` — CPython ≥3.8 emits its own SyntaxWarning.
- `type(x) == T` vs `isinstance` — marginal frequency for v1.

## Rollout & staleness

`Meta.graphVersion` (currently `2`, `code-graph/build.ts`): an incremental update against an
older graph throws `FullRebuildRequired` → callers fall back to a full build. Without this, an
upgraded Plex would never index a repo's *existing* `.py` files (incremental touches only changed
files) and Python repos would silently stay symbol-less. Bump it whenever extractor output
changes in a way incremental can't reproduce.

The version is ALSO stamped into a **`graph.version` sidecar** beside `head.sha`, checked by the
review-time staleness gate (no Kùzu open): a mismatch — or a missing sidecar (legacy install) —
triggers the refresh **even at `behind === 0`**, so the one-time post-upgrade rebuild fires at an
unchanged HEAD too (pinned E2E in `scripts/py-check.mjs`).

**Degraded builds self-heal.** If a language runtime fails to load (`plugin.init` throws), the
build skips that language's files and reports `skippedLanguages` — and neither `Meta.graphVersion`
nor the sidecar is stamped, so the next review's version gate keeps retrying until the runtime
loads. An incremental update **preflights** the runtimes of its changed files BEFORE the
DETACH-DELETE phase and throws `FullRebuildRequired` on failure — a transient wasm error can never
erase modified files' symbols while `headSha` advances. Per-file guards mirror `uniqueSymbolId`'s
invariant: one pathological file (unreadable, or an extractor throw) never aborts an index or a
review — it is skipped, in both the graph build and the deterministic runner/prevalence sample.

Known TS-parity limitation: adding `pkg/name.py` (or adding/deleting an `__init__.py`) does not
re-resolve UNCHANGED importers' edges until their files change or a full rebuild runs — TS has
the identical behavior for a new `foo/index.ts`. Barrel transparency mitigates the common case.

## Discovery & hygiene

- Git repos: `.gitignore` remains authoritative (a committed `.venv` is the user's problem —
  documented stance). Non-git walk: SKIP_DIRS += `venv`, `__pycache__`, `site-packages`, plus an
  `*.egg-info` suffix skip; dot-dirs (`.venv`, `.tox`, `.mypy_cache`, …) were already skipped.
- `isGeneratedArtifact` += `.pyc`, `_pb2(_grpc)?.py` (protobuf codegen is git-tracked machine
  output that floods symbols and dilutes co-change size factors). Python lockfiles were already
  listed. `.ipynb` is NOT generated (authored source — just unparsed in v1) so its co-change
  signal stays.
- `.pyi` is excluded (the `.d.ts` analog): declaration-only, and it would collide with the
  same-named `.py` in the module index.
