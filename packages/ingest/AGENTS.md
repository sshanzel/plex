# @plex/ingest

Diff adapters. Every review input — local working tree, index, branch, or a GitHub PR —
reduces to one `NormalizedDiff` (**ADR-14: "all inputs normalize to diff vs base ref"**;
PR-vs-local is not a meaningful internal distinction, `gh` is just an adapter). This is
the entry point of the review flow: the `NormalizedDiff` feeds `@plex/neighborhood`
(blast radius), the deterministic runner, and the brain's round bookkeeping. The package
also carries the small `gh` write path (posting a review back to a PR, ADR-34).

## Module map

- `src/normalize.ts` — pure unified-diff parsing (`parse-diff`) → `NormalizedDiff`;
  `groupRanges`; `addedTextByFile` (per-file added-line text for round attribution).
- `src/local.ts` — `git diff` adapters (`working` / `staged` / `branch`) + branch
  narrative helpers (`getCommitSubjects`, `getHeadSha`, `getChangedFileTexts`).
- `src/github.ts` — `gh` CLI adapters: `getPrDiff`, `getPrMeta`, `getPrHeadSha`, `getPrState`
  (`OPEN`/`CLOSED`/`MERGED`, or `''` on failure — disambiguates a closed PR from a gh error for the
  ADR-43 sweep), and `postPrReview` (the ADR-34 auto-comment write path).
- `src/parse-diff.d.ts` — minimal ambient types for `parse-diff` (ships none); only the
  consumed subset is declared.

## The logic

**Normalization (`normalizeUnifiedDiff`, pure).** Generated artifacts (lockfiles,
`*.min.*`, source maps, snapshots — `isGeneratedArtifact`, `@plex/core`) are **dropped
here, at the single entry point**: they never reach the review context, the deterministic
runner, or the brain's bookkeeping; `addedTextByFile` skips them too (a regenerated
lockfile is never embedded). Each surviving parsed file becomes a `DiffFile`:

- `path` = the to-side unless it's `/dev/null` (then the from-side); `oldPath` only when
  it's a real rename.
- `status` (`statusOf`): `added` / `deleted` from parse-diff flags; `renamed` when both
  sides exist, differ, and neither is `/dev/null`; else `modified`.
- Per hunk, only **added** lines (`type === 'add'`, new-side `ln`) are collected and
  grouped into contiguous inclusive `newRanges` (`groupRanges` dedups + sorts first).
  Deletions and context lines carry no new-side anchor, so downstream consumers (symbol
  intersection, inline PR comments) only ever reason about the **new side** of the diff.

**Added-text extraction (`addedTextByFile`, pure — ADR-23).** For inter-round change
attribution the brain embeds *what actually changed*, not line numbers: per file, the
added lines' min/max span + their text joined and **capped at 4000 chars**; files with
zero added lines (pure deletions) are skipped. Min/max is tracked incrementally — a
`Math.min(...lines)` spread overflows the call stack on ~100k+ added lines (generated
bundles), a real bug this replaced.

**Local adapters (`getLocalDiff`).** Mode → git invocation:

- `working` → `git diff HEAD` (staged **and** unstaged vs HEAD), baseRef label
  `HEAD (working)`;
- `staged` → `git diff --cached`, label `HEAD (staged)`;
- `branch` → `git diff <baseRef>...HEAD` (**triple-dot** — diff vs the merge base, so a
  stale base branch doesn't pollute the review), baseRef default `main`.

All git/gh calls go through `execFile` (no shell) with a 64 MiB `maxBuffer`.
`getCommitSubjects` (`baseRef..HEAD`, no merges, default limit 20) gives the branch
review its narrative; `getHeadSha` keys a review round (ADR-23); `getChangedFileTexts`
diffs `fromSha..toSha` and feeds `addedTextByFile` — the inter-round delta that reconcile
and "changed-without-feedback" classify.

**PR adapters (`github.ts`).** `getPrDiff` shells `gh pr diff <n>` and normalizes with
baseRef `pr/<n>` — identical shape to a local diff (ADR-14). `getPrMeta`
(title/body/url — the *stated* motivation; never the author's reasoning, ADR-02) and
`getPrHeadSha` (`headRefOid`) are best-effort: they return `{}` / `''` on failure rather
than throwing. `postPrReview` posts **one** review per call (`event: COMMENT` — never
approve/request-changes) with a summary body + inline comments anchored
`side: 'RIGHT'` on new-side lines; the JSON payload goes through a temp file
(`gh api --input`) because `execFile` can't pipe stdin. It **throws** on failure — the
caller (`rankReviewFindings`, ADR-34) treats posting as best-effort and never fails the
review over it.

## Invariants & gotchas

- **Everything in `normalize.ts` is pure** — directly unit-testable, no git/gh. Process
  spawning stays in `local.ts`/`github.ts` (root convention: pure core, impure edges).
- `newRanges` contain **added lines only**. A pure-deletion hunk has `newRanges: []`;
  don't infer "untouched" from an empty range list — check the hunk's `oldLines` too.
- Best-effort vs throwing is deliberate per function: diff getters throw (a review
  without a diff is meaningless); metadata/sha/subject helpers swallow errors and return
  empty (a review without a title is fine). Keep new helpers on the right side.
- **`runGit` retries a transient SPAWN failure** (`isTransientSpawnError` — `EAGAIN`/`ENOMEM`/
  `EMFILE`/… where the child never forked, e.g. under CI fork-storm) but NOT a non-zero exit
  (`code` is a number — a real failure like a bad ref). This is a **correctness** fix, not flake
  suppression: without it a transient `getHeadSha` → `''` records a review round with an empty
  `headSha`, which silently kills round-over-round drift attribution AND reconcile (both key off
  `lastHeadSha`). A swallowed-to-empty getter still degrades on a *real* failure — only the
  never-ran spawn case is retried.
- The 4000-char `addedTextByFile` cap bounds embedding cost; raise it only with the
  brain's token budget in mind.
- Diff paths are repo-relative POSIX as git emits them — they must match
  `@plex/code-graph` `File.id`s untouched (no normalization happens here).
- `parse-diff` has fooled a hand-written multi-file diff before (M0 notes) — that is why
  fixtures are real git output, and why the ambient `.d.ts` declares only the consumed
  subset.

## Testing

- `src/normalize.test.ts` (vitest, pure): range grouping, status classification
  (added/deleted/renamed + `oldPath`), empty diffs, the 4000-char cap, the huge-file
  stack-overflow regression.
- `src/local.test.ts` (vitest, **real git**): builds a throwaway repo with
  `git init` + commits in `mkdtempSync` dirs and asserts `working`/`staged`/`branch`
  diffs against it — the real-fixture convention (synthetic diff strings already fooled
  `parse-diff` once). No Kùzu anywhere in this package, so plain vitest is safe (ADR-17
  doesn't bite here); the gh adapters are exercised by the engine's PR-level checks, not
  unit-mocked.

See `docs/adr/README.md` (ADR-14, -23, -34) and the root `AGENTS.md` for the review flow.
