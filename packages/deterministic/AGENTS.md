# @plex/deterministic

The **codified-checks source**: deterministic findings over a diff's changed files, restricted to
changed lines, via built-in per-language rule sets — TS/JS on the TypeScript compiler API
(ADR-15) and Python on tree-sitter WASM via `@plex/lang-python` (ADR-52). This is the **always-on structural layer** — the complement to the agent's judgment
(ADR-03's third leg): 100% recall on each rule's pattern, ~free, reproducible, and what feeds
measured prevalence. Output is plain `Finding[]` with `source: 'deterministic'` — these merge into
the **same ranked stream** as the agent's findings. Decision log:
[`docs/adr/README.md`](../../docs/adr/README.md) (ADR-03/15). (External-scanner integration —
ast-grep/Semgrep — was removed in ADR-37; the future shape is `plex.json` config that *defers* to
the linter you already run, not a runner Plex spawns.)

Where it sits: `get_review_context` and `get_deterministic_findings` surface these to the reviewing
agent up front; `submit_findings` (`engine/src/findings.ts#rankReviewFindings`,
`includeDeterministic` default true) re-runs `runDeterministic` and appends them before
dedupe/rank, so an agent finding at the same `file:startLine:title` is *corroborated* (noisy-OR
confidence in `@plex/findings`), and a rule the agent missed still reaches the user.

## Module map

| File | Responsibility |
|---|---|
| `src/builtin.ts` | `analyzeSource` — the built-in TS-AST rules over one source file (pure) |
| `src/builtin-py.ts` | `analyzePySource` — the Python rules over a tree-sitter parse (pure, sync after `initPython()`); `PY_RULES` |
| `src/analyze.ts` | the ONLY dispatch point: `analyzerFor(file)` capability map, `ruleLanguage(rule)`, back-compat `isSupportedSource` |
| `src/runner.ts` | `runDeterministic` — walk the diff's files, read from disk, scope to changed lines, `RawFinding` → `Finding`; hoists the async wasm init; per-language prevalence |
| `src/index.ts` | Barrel |

## The rules (`src/builtin.ts`)

Each rule emits a fixed severity + confidence — **separate axes** (ADR-04): `no-empty-catch` is a
real `improvement` we're 0.85 sure about, not a "nit".

| Rule | Trigger | Severity | Confidence |
|---|---|---|---|
| `no-debugger` | `debugger` statement | bug | 0.95 |
| `no-explicit-any` | `any` keyword | nit | 0.7 |
| `no-loose-equality` | `==`/`!=` where **neither** side is `null`/`undefined` (`== null` is exempt) | nit | 0.9 |
| `no-console` | `console.<method>(...)` call | nit | 0.6 |
| `no-empty-catch` | `catch` with an empty block | improvement | 0.85 |

Python rules (`src/builtin-py.ts`, ADR-52 — rule ids are 1:1 per language, so `pattern-repo`
waivers and prevalence never cross languages):

| Rule | Trigger | Severity | Confidence |
|---|---|---|---|
| `no-breakpoint` | `breakpoint()`, `pdb`/`ipdb` `.set_trace()`, `pdb`/`ipdb` imports | bug | 0.95 |
| `mutable-default-arg` | list/dict/set literal, comprehension, or bare `list`/`dict`/`set` call as a parameter default | bug | 0.9 |
| `no-return-in-finally` | `return` whose nearest {`finally`, def, lambda} ancestor is the `finally` | bug | 0.85 |
| `no-bare-except` | `except:` with no type and a real body | improvement | 0.9 |
| `no-silent-except` | except body solely `pass`/`...` — priority over bare (ONE finding per clause) | improvement | 0.85 |
| `use-is-none` | `==`/`!=` **adjacent** to a `None` operand (`a == b is None` exempt) | nit | 0.9 |
| `no-print` | bare `print(...)` — 0.5 (below `no-console`): CLIs print; measured prevalence demotes per repo | nit | 0.5 |

Python rule walks **skip `ERROR` subtrees** (tree-sitter parses broken files tolerantly; no
phantom findings mid-edit). Rejected rules + reasons: `docs/design/python-support.md`.

> **Removed:** `no-await-in-loop` (`await` lexically inside a loop, improvement @ 0.55) — a
> low-confidence perf heuristic that's frequently intentional (sequential ordering). It fired
> unconditionally on every diff, and because deterministic rules have **no confidence-feedback
> loop** (rejecting one only suppresses that file/line instance via a waiver, never the rule
> itself), it re-surfaced no matter how often the user dismissed it. Dropped rather than demoted.

`analyzeSource` is a single recursive `visit(node)` over a `ts.createSourceFile` AST (no
type checker — syntax only).
Lines are 1-based via `getLineAndCharacterOfPosition`. `scriptKind` maps the extension so `.tsx`
/`.jsx`/plain JS parse correctly. Which files are analyzed at all is decided by `analyzerFor`
(`src/analyze.ts`, keyed on `@plex/core` `languageOf`) — a file whose language has no analyzer is
skipped.

**Enclosing symbol (ADR-48).** Each `RawFinding` carries `symbol?` = the nearest enclosing named
declaration (`enclosingSymbol` walks the parent chain: function/method/accessor/class, or a
`const f = () => …` / `const f = function …` binding; undefined at top level) → `Finding.location.symbol`.
This is what lets **location-scoped suppression** (ADR-48) scope a deterministic dismissal to its
symbol — without it a `no-console` dismissal could only ever go repo-wide. The name is **stable across
rounds** (re-derived from the same AST), which is all the symbol-scoping match needs. The TS walker
intentionally does **not** mirror the code graph's `Class.method` qualification (a same-named method in
two classes in one file could collide — rare, accepted). **The Python walker DOES qualify
(`Class.method`, innermost class)** — a deliberate divergence: dunders (`__init__` in every class)
collide constantly, which would over-broaden suppression; dotting also makes deterministic symbols
equal the graph extractor's names (cross-pinned by a test in `builtin-py.test.ts`).

## The runner (`src/runner.ts`)

For each diff file (skipping `status === 'deleted'`, unsupported extensions, and generated
artifacts — a `.min.js` IS a supported extension, so the `isGeneratedArtifact` skip is
belt-and-suspenders for hand-built diffs; normalization already drops them):

1. Read the file's **current text from disk** (`repoPath + file.path`) — not the diff hunks; a read
   failure (file missing on disk) skips the file silently.
2. Collect changed ranges: `ranges = f.hunks.flatMap((h) => h.newRanges)` (new-side line ranges
   from `@plex/ingest`'s `NormalizedDiff`).
3. Run the file's language analyzer (`analyzerFor` — `.py` inits the wasm parser once, hoisted
   before the loop), keep a raw finding only if it **overlaps a changed range**
   (`raw.startLine <= r.end && r.start <= raw.endLine`) — review new code, not old.
   `onlyChangedRanges: false` disables the filter (whole-file scan).
4. Convert to `Finding`: id `det:<rule>:<file>:<startLine>`, `source: 'deterministic'`,
   `tags: [rule]` — the tag is what a `pattern-repo` waiver's `pattern` matches against, so a user
   can waive a whole rule (e.g. `no-console`) for the repo. `location.symbol` carries `raw.symbol`
   (the **enclosing-symbol** name, ADR-48) — see below.
5. **Measured prevalence** (`rulePrevalence`, default on; only when something fired): each
   finding is stamped with its rule's repo prevalence = the fraction of sampled source files
   with ≥1 hit of the same rule (breadth-first sample, `prevalenceFileCap` default **400** —
   a sample, not a census; `SKIP_DIRS` + dot-dirs + `.d.ts` excluded). This makes ADR-05's
   prevalence-by-severity read rest on DATA for codified findings (a `no-console` in 40% of
   files demotes to convention; a widespread `no-debugger` escalates as systemic) — agent
   findings still carry agent-supplied prevalence.

**Changed-line gotcha:** the filter short-circuits when `ranges.length === 0` — a file with **no
captured ranges** (e.g. an added file whose hunks weren't captured) gets ALL its findings emitted,
not zero. That's deliberate (a brand-new file is entirely "changed") and pinned by
`runner.test.ts`; don't "fix" it into silence.

`repoName` defaults to `basename(resolve(repoPath))` — the engine passes the same, keeping
`Finding.location.repo` consistent with the agent findings it merges with.

## Why a deterministic layer at all (vs. the agent)

Not redundant with the LLM — *complementary* (ADR-03's tripod). The agent is better at judgment;
a structural pattern matcher is better at four things the agent structurally can't do well:
**guarantee** (a rule fires 100% of the time on its pattern, no token spend, no "the agent was
focused elsewhere" — vs. a retrieved pitfall, which is top-K *guidance* the agent may not surface);
**cost/scale** (running a rule across 10k files is free — this is how prevalence is measured);
**absence** (a rule encodes "this must NOT appear" and catches the violation regardless of what
else is in the diff — retrieval is presence-keyed and misses absence-bugs); **reproducibility**
(same rule, every PR, same result — CI's job, not an LLM's). That's why this layer stays even
though the agent gets everything else.

## Invariants & gotchas

- **Severity and confidence are separate axes** (ADR-04) — when adding a rule, pick both
  deliberately; never encode uncertainty as a lower severity.
- Deterministic findings enter the **same merge/dedup/rank stream** (`@plex/findings`) — never a
  separate report. Prevalence-by-severity (ADR-05) applies to them too: a widespread
  `no-debugger` hit escalates as systemic, it is not demoted as a convention.
- `analyzeSource` is pure (string in, findings out); keep the fs/process work in
  `runner.ts` (root "pure core, impure edges" convention).
- Finding ids are positional (`det:<rule>:<file>:<startLine>`) — stable across runs only while the
  code doesn't move; cross-round identity is handled downstream (waivers/brain), not here.

## Testing

All **vitest units** (`pnpm test:unit`) — no Kùzu, so nothing needs the tsx-isolated integration
lane (ADR-17). `src/builtin.test.ts` pins each rule (incl. the `== null` exemption); `src/runner.test.ts` uses a real temp-dir repo
fixture (root convention: real fixtures over synthetic strings) and pins the changed-range filter,
the no-ranges (new file) fallthrough, the skip paths, and the `repoName` default.
