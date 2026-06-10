# @plex/deterministic

The **codified-checks source**: deterministic findings over a diff's changed files, restricted to
changed lines. The always-available baseline is a set of built-in TS-AST rules (the TypeScript
compiler API — ADR-15, no tree-sitter); Semgrep / ast-grep are *detected* as optional external
scanners but their output is not parsed yet (extension point, see below). Output is plain
`Finding[]` with `source: 'deterministic'` — these merge into the **same ranked stream** as the
agent's findings. Decision log: [`docs/adr/README.md`](../../docs/adr/README.md) (ADR-03/15).

Where it sits: `get_review_context` and `get_deterministic_findings` surface these to the reviewing
agent up front; `submit_findings` (`engine/src/findings.ts#rankReviewFindings`,
`includeDeterministic` default true) re-runs `runDeterministic` and appends them before
dedupe/rank, so an agent finding at the same `file:startLine:title` is *corroborated* (noisy-OR
confidence in `@plex/findings`), and a rule the agent missed still reaches the user.

## Module map

| File | Responsibility |
|---|---|
| `src/builtin.ts` | `analyzeSource` — the built-in TS-AST rules over one source file (pure); `isSupportedSource` |
| `src/runner.ts` | `runDeterministic` — walk the diff's files, read from disk, scope to changed lines, `RawFinding` → `Finding` |
| `src/external.ts` | `detectExternalTools` / `isAvailable` — probe for `semgrep` / `ast-grep` binaries |
| `src/index.ts` | Barrel |

## The rules (`src/builtin.ts`)

Each rule emits a fixed severity + confidence — **separate axes** (ADR-04): `no-await-in-loop` is a
real `improvement` we're only 0.55 sure about, not a "nit".

| Rule | Trigger | Severity | Confidence |
|---|---|---|---|
| `no-debugger` | `debugger` statement | bug | 0.95 |
| `no-explicit-any` | `any` keyword | nit | 0.7 |
| `no-loose-equality` | `==`/`!=` where **neither** side is `null`/`undefined` (`== null` is exempt) | nit | 0.9 |
| `no-console` | `console.<method>(...)` call | nit | 0.6 |
| `no-empty-catch` | `catch` with an empty block | improvement | 0.85 |
| `no-await-in-loop` | `await` lexically inside `for`/`for-of`/`for-in`/`while`/`do` | improvement | 0.55 |

`analyzeSource` is a single recursive `visit(node, inLoop)` over a `ts.createSourceFile` AST (no
type checker — syntax only). The `inLoop` flag **resets to false on entering any function** (incl.
arrows/methods), so an `await` inside a callback defined in a loop body is correctly *not* flagged.
Lines are 1-based via `getLineAndCharacterOfPosition`. `scriptKind` maps the extension so `.tsx`
/`.jsx`/plain JS parse correctly; `isSupportedSource` accepts
`.ts .tsx .js .jsx .mts .cts .mjs .cjs` (`TS_EXTS`) — anything else is skipped.

## The runner (`src/runner.ts`)

For each diff file (skipping `status === 'deleted'` and unsupported extensions):

1. Read the file's **current text from disk** (`repoPath + file.path`) — not the diff hunks; a read
   failure (file missing on disk) skips the file silently.
2. Collect changed ranges: `ranges = f.hunks.flatMap((h) => h.newRanges)` (new-side line ranges
   from `@plex/ingest`'s `NormalizedDiff`).
3. Run `analyzeSource`, keep a raw finding only if it **overlaps a changed range**
   (`raw.startLine <= r.end && r.start <= raw.endLine`) — review new code, not old.
   `onlyChangedRanges: false` disables the filter (whole-file scan).
4. Convert to `Finding`: id `det:<rule>:<file>:<startLine>`, `source: 'deterministic'`,
   `tags: [rule]` — the tag is what a `pattern-repo` waiver's `pattern` matches against, so a user
   can waive a whole rule (e.g. `no-console`) for the repo.

**Changed-line gotcha:** the filter short-circuits when `ranges.length === 0` — a file with **no
captured ranges** (e.g. an added file whose hunks weren't captured) gets ALL its findings emitted,
not zero. That's deliberate (a brand-new file is entirely "changed") and pinned by
`runner.test.ts`; don't "fix" it into silence.

`repoName` defaults to `basename(resolve(repoPath))` — the engine passes the same, keeping
`Finding.location.repo` consistent with the agent findings it merges with.

## External tools (`src/external.ts`) — graceful degradation

`detectExternalTools()` probes `semgrep` and `ast-grep` by spawning `<bin> --version`
(`execFile`; any failure including ENOENT → `false` — never throws). When present they are meant to
become **additional deterministic sources** — the documented extension point is "parse their JSON
output into `Finding[]` and merge". **That wiring does not exist yet**: nothing outside this
package calls `detectExternalTools`, and `runDeterministic` runs only the built-in rules. The
built-ins are the always-available baseline, so a review **never depends on either tool being
installed** — no error, no degraded mode messaging; you simply get the built-in findings.

## Invariants & gotchas

- **Severity and confidence are separate axes** (ADR-04) — when adding a rule, pick both
  deliberately; never encode uncertainty as a lower severity.
- Deterministic findings enter the **same merge/dedup/rank stream** (`@plex/findings`) — never a
  separate report. Prevalence-by-severity (ADR-05) applies to them too: a widespread
  `no-debugger` hit escalates as systemic, it is not demoted as a convention.
- Rules here are the **promotion target** for codifiable pitfalls (M5 `propose_promotions`
  emits ast-grep-style rules) — keep each rule cheap, syntax-only, and pure.
- `analyzeSource` is pure (string in, findings out); keep the fs/process work in
  `runner.ts`/`external.ts` (root "pure core, impure edges" convention).
- Finding ids are positional (`det:<rule>:<file>:<startLine>`) — stable across runs only while the
  code doesn't move; cross-round identity is handled downstream (waivers/brain), not here.

## Testing

All **vitest units** (`pnpm test:unit`) — no Kùzu, so nothing needs the tsx-isolated integration
lane (ADR-17). `src/builtin.test.ts` pins each rule (incl. the `== null` exemption and the
loop/function boundary for `no-await-in-loop`); `src/runner.test.ts` uses a real temp-dir repo
fixture (root convention: real fixtures over synthetic strings) and pins the changed-range filter,
the no-ranges (new file) fallthrough, the skip paths, and the `repoName` default.
