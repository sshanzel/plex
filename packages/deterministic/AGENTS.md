# @plex/deterministic

The **codified-checks source**: deterministic findings over a diff's changed files, restricted to
changed lines, via a set of built-in TS-AST rules (the TypeScript compiler API — ADR-15, no
tree-sitter). This is the **always-on structural layer** — the complement to the agent's judgment
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
| `src/builtin.ts` | `analyzeSource` — the built-in TS-AST rules over one source file (pure); `isSupportedSource` |
| `src/runner.ts` | `runDeterministic` — walk the diff's files, read from disk, scope to changed lines, `RawFinding` → `Finding` |
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

For each diff file (skipping `status === 'deleted'`, unsupported extensions, and generated
artifacts — a `.min.js` IS a supported extension, so the `isGeneratedArtifact` skip is
belt-and-suspenders for hand-built diffs; normalization already drops them):

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
lane (ADR-17). `src/builtin.test.ts` pins each rule (incl. the `== null` exemption and the
loop/function boundary for `no-await-in-loop`); `src/runner.test.ts` uses a real temp-dir repo
fixture (root convention: real fixtures over synthetic strings) and pins the changed-range filter,
the no-ranges (new file) fallthrough, the skip paths, and the `repoName` default.
