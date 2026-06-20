/**
 * Is `ref` safe to hand to git as a single argv token? Guards against option-injection (a leading `-`
 * git reads as a flag). Deliberately ALLOWS `~ ^ @ { } :` so `HEAD~3`/`main@{upstream}`/`origin/main`
 * still work — they carry no injection risk once a leading `-` is excluded.
 */
export function isSafeGitRef(ref: string): boolean {
  if (!ref || ref.length > 256) return false;
  if (ref.startsWith('-')) return false; // option-injection: git would read it as a flag
  if (ref === '..') return false; // a bare range operator is never a base ref
  return /^[A-Za-z0-9._/~^@{}:-]+$/.test(ref);
}

/** Is `pr` a safe PR number (positive integer) for `gh`? Same option-injection concern as {@link isSafeGitRef}. */
export function isSafePrNumber(pr: string | number): boolean {
  if (typeof pr === 'number') return Number.isInteger(pr) && pr > 0;
  return /^\d+$/.test(pr);
}
