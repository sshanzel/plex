/**
 * Stable `file#name` symbol key anchoring a concern to a code location (ADR-47, code-path memory).
 * Drift-tolerant by design: NOT `Symbol.id` (`file#name#startLine` breaks on line drift) and NOT bare
 * `name` (collides across files) — a moved symbol keeps its key, a renamed one becomes a new key.
 * Single source of truth so capture, match, and the viz join never disagree on "same symbol".
 */
export function symbolKey(file: string, name: string): string {
  return `${file}#${name}`;
}

/**
 * Re-anchor a path-keyed `file`/`symbol` pair across file renames (ADR-53). Pure. `map` is old→new
 * repo-relative POSIX paths (a review diff's renames). `file` is looked up whole; a `file#name` symbol
 * has its FILE segment (everything before the first `#`) looked up and swapped — a prefix rule, robust
 * even in the pathological case of a `#` inside `name`. Returns `changed:false` untouched when neither
 * anchor matched, so callers can skip the store rewrite entirely.
 */
export function remapAnchor(
  map: ReadonlyMap<string, string>,
  file?: string,
  symbol?: string,
): { file?: string; symbol?: string; changed: boolean } {
  let changed = false;
  let f = file;
  let s = symbol;
  if (file !== undefined) {
    const to = map.get(file);
    if (to !== undefined) {
      f = to;
      changed = true;
    }
  }
  if (symbol !== undefined) {
    const hash = symbol.indexOf('#');
    const segFile = hash === -1 ? symbol : symbol.slice(0, hash);
    const to = map.get(segFile);
    if (to !== undefined) {
      s = hash === -1 ? to : to + symbol.slice(hash);
      changed = true;
    }
  }
  return { file: f, symbol: s, changed };
}
