/**
 * Is `ref` safe to hand to git as a single argv token?
 *
 * Plex never uses a shell (every git call is `execFile`/`spawn` with an argv array), so a ref
 * cannot inject a *command*. The one residual risk is **option-injection**: a value beginning
 * with `-` is parsed by git as a flag rather than a revision (e.g. `--upload-pack=…`,
 * `--output=…`). `baseRef` is operator-supplied (the user running the review picks the base),
 * so this is defense-in-depth, not an attacker path — but it's cheap to refuse a ref that could
 * never be a real revision.
 *
 * We reject: empty, over-long, a leading `-`, a bare `..`, and any char outside the set used by
 * real branch/tag/SHA/revision syntax. We deliberately still ALLOW `~ ^ @ { } :` so common
 * revisions (`HEAD~3`, `main@{upstream}`, `origin/main`) keep working — they carry no
 * option-injection risk once a leading `-` is excluded.
 */
export function isSafeGitRef(ref: string): boolean {
  if (!ref || ref.length > 256) return false;
  if (ref.startsWith('-')) return false; // option-injection: git would read it as a flag
  if (ref === '..') return false; // a bare range operator is never a base ref
  return /^[A-Za-z0-9._/~^@{}:-]+$/.test(ref);
}

/**
 * Is `pr` a safe PR number to pass as a single argv token to `gh`? A PR number is a positive
 * integer; anything else (notably a leading `-`, e.g. `--paginate`) could be read by `gh` as an
 * option. Same option-injection concern as {@link isSafeGitRef}, narrower domain.
 */
export function isSafePrNumber(pr: string | number): boolean {
  if (typeof pr === 'number') return Number.isInteger(pr) && pr > 0;
  return /^\d+$/.test(pr);
}
