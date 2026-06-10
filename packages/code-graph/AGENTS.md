# @plex/code-graph

The per-repo **Kùzu code graph**: TS/JS symbols + imports (TS compiler API, ADR-15) and
git **co-change** coupling (ADR-06), built once and refreshed incrementally (ADR-25/26).
In the review flow it is the durable substrate that `@plex/neighborhood` walks to compute
a diff's blast radius. One graph per repo path, stored at `~/.plex/repos/<id>/graph.kuzu`
(see the root `AGENTS.md`; the data dir is owned by the engine, not this package).

## Module map

- `src/db.ts` — `CodeGraphDB`: thin Kùzu `Database`+`Connection` wrapper; prepared
  `$params`, bulk `insertMany`, lock-error → `RepoBusyError`, ordered close.
- `src/schema.ts` — DDL: `File` / `Symbol` / `Meta` nodes; `Declares` / `Imports` /
  `Refs` / `CoChange` rel tables.
- `src/extract-ts.ts` — single-SourceFile structural extraction (symbols + raw import
  specifiers) and the relative-import resolver. No type checker.
- `src/precise.ts` — tsconfig-aware (`paths`/`baseUrl`) module resolution via
  `ts.resolveModuleName` → `Refs` edges the relative resolver missed.
- `src/co-change.ts` — pure `aggregateCoChange` (the weighting math) + the impure git
  readers (`readCommits`, `changedSourceFilesSince`, `headSha`, `commitsBehind`).
- `src/build.ts` — `buildCodeGraph` (full) and `updateCodeGraph` (incremental, ADR-25/26);
  throws `FullRebuildRequired` when incremental can't run.
- `src/query.ts` — read surface: symbols per file, undirected edge/degree queries used by
  the neighborhood walk, `getMeta`.

## The algorithm

**Schema / ids.** `File.id` = the **repo-relative POSIX path** (`path.relative(...).split(sep).join('/')`),
`Symbol.id` = `<file>#<name>#<startLine>`. Edges are unioned by provenance (ADR-06):
`Imports` (relative resolver), `Refs` (precise, alias-aware), `CoChange {weight, cnt}` (git).
`Meta` stores `headSha` (the indexed commit) and `repo`.

**Extraction (ADR-15).** `extractFromSource` parses one `ts.createSourceFile` — fast, no
program, no type checker. It records functions, classes (+ identifier-named methods as
`Class.method`), interfaces, type aliases, enums, and `const`s whose initializer is an
arrow/function/class expression; `exported` via `ts.getCombinedModifierFlags`. Supported
extensions are `TS_EXTS` (`.ts .tsx .js .jsx .mts .cts .mjs .cjs`); **`.d.ts` is excluded**
everywhere (`build.ts discoverFiles`, `co-change.ts isIndexable`). `resolveRelativeImport`
tries `base`, `base+ext`, `base/index+ext` against the discovered file set; bare specifiers
return null and are left to `precise.ts`, which resolves with the repo's real tsconfig
(fallback options: `allowJs` + `ModuleResolutionKind.Bundler`), skips `node_modules`, and
only stores edges **not already** present as `Imports`.

**Co-change weighting (ADR-06 — never raw counts).** `aggregateCoChange` in
`src/co-change.ts`: per commit touching `n` files (after dedup; skipped if `n < 2` or
`n > maxCommitFiles`), every pair gets

```
contribution = recency × sizeFactor
recency      = 0.5 ^ (ageSec / (halfLifeDays · 86400))   // halfLifeDays ≤ 0 ⇒ 1 (no decay, NaN guard)
sizeFactor   = 1 / (n − 1)                               // 2-file commit = strong evidence; 25-file ≈ noise
```

Generated artifacts (`isGeneratedArtifact`, `@plex/core`) are filtered from each commit's
file list **before** `n` is counted — a 2-source-file commit that also regenerates
`pnpm-lock.yaml` is n=2 evidence, not n=3.
Age is clamped `Math.max(0, now − ts)` (future-dated commits contribute 1, never > 1).
Pairs with `count < minPairCount` are dropped — kills singleton N² noise. Defaults
(`@plex/core` `defaultConfig.coChange`): `maxCommitFiles: 25`, `halfLifeDays: 365`,
`minPairCount: 2`, `maxCommits: 5000` — basis in `docs/design/tuning.md` §co-change.
History is read via `git log --no-merges --name-only` with an SOH (0x01) record marker;
`old => new` rename artifacts keep the new path.

**Full build (`buildCodeGraph`).** Wipes `dbDir` (unless `fresh: false`), walks the repo
(skipping `SKIP_DIRS` + dot-dirs), inserts Files → Symbols/Declares → Imports → Refs →
fileSet-filtered CoChange pairs, then stamps `Meta.headSha` + `Meta.repo`. Co-change is
best-effort: a non-git dir simply has no co-change layer.

**Incremental update (`updateCodeGraph`, ADR-25/26).** Diffs `storedSha..HEAD`
(`git diff --name-status -M`; renames split into delete(old)+add(new)). Then:
1. **Deleted** files: `DETACH DELETE` Symbols + File (incoming edges go too).
2. **Modified** files: keep the File node so **incoming** edges from unchanged importers
   survive; delete only its Symbols and **outgoing** `Imports`/`Refs`.
3. Re-extract only added/modified files — O(changed files), skipping the dominant
   whole-repo TS parse.
4. **Co-change merges only the new commits** (`readCommits(…, sinceRef)`), aggregated with
   `minPairCount: 1` then split: pairs reaching the threshold **within the window**
   create-or-accumulate (`MERGE … ON CREATE/ON MATCH`); sub-threshold pairs accumulate
   into already-stored pairs, and the rest are **staged in `CoChangePending`** — a lane
   read queries never traverse — where they accumulate **across windows** and PROMOTE to a
   real `CoChange` edge once their total `cnt` reaches `minPairCount`. A `CoChange`
   singleton is still never created from one window (ADR-06 denoising), but a coupling
   landing one commit per window (a review-triggered refresh after every commit) is no
   longer forgotten. Pending resets on a full rebuild. No epoch bookkeeping: the age clamp
   gives new commits full recency, and decay re-baselines on every full build (ADR-26).
No stored sha / undiffable sha (force-push) ⇒ `FullRebuildRequired` — callers fall back to
`buildCodeGraph`. Worktree note (ADR-32): a secondary worktree's graph is seeded by
*copying* the base graph then running this incremental path — the copy carries the BASE
repo's `Meta.repo`, which is why brain keys must come from `reviewTargetFor`, never graph
meta (root `AGENTS.md` invariant).

## Invariants & gotchas

- **Prepared statements with named `$params`** for anything carrying file paths/user data —
  never string-concatenate Cypher. `insertMany` prepares once and executes per row.
- **Close the `Connection` before the `Database`** (`CodeGraphDB.close()`) — the reverse
  leaks the native handle and crashes vitest worker teardown.
- Kùzu is **single-writer**: a concurrent open of the same dir throws a lock IOException
  (sometimes lazily at first query) — both paths are translated to `RepoBusyError`.
- Weighted co-change only — `CoChange.weight` is the decayed/size-normalized sum; `cnt`
  exists for thresholding, not ranking.
- File ids are repo-relative **POSIX** paths; always convert `path.sep` → `/` before
  querying or inserting.
- Read queries (`query.ts`) traverse edges **undirected** (`-[c:CoChange]-`, `-[:Imports]-`)
  and expand frontiers with `WHERE a.id IN $ids` — coupling has no direction.
- `getCouplingDegrees` enumerates rel types explicitly (`[r:CoChange|Imports|Refs]`) —
  `CoChangePending` is a staging lane that reads must NEVER count or traverse.

## Testing

- **Unit (vitest, pure):** `src/co-change.test.ts` (sizeFactor, half-life decay, the
  `maxCommitFiles` boundary, the `halfLifeDays ≤ 0` NaN guard, future-clock clamp),
  `src/extract-ts.test.ts`. Nothing here opens Kùzu — a `.test.ts` that does will crash
  vitest teardown (ADR-17).
- **Integration:** scenarios live in `packages/engine/integration.mts` (`build`,
  `incremental`, `cochange-inc`, `cochange-weak`, `precise`, `worktree-seed`, …), run via
  `pnpm test:integration` — **one tsx process per scenario, ≤2 Kùzu opens each** (tsx
  SIGSEGVs after ~5 opens; ADR-17). Fixtures are real: a throwaway `git init` repo under
  `mkdtempSync` + a temp `g.kuzu` dir, never synthetic diffs/graphs.

See `docs/adr/README.md` (ADR-06, -15, -17, -25, -26, -32) and `docs/design/tuning.md`.
