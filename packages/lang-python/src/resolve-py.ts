import path from 'node:path';

/** Dotted module path → candidate repo-relative files (deduped, insertion-ordered). */
export type PyModuleIndex = Map<string, string[]>;

// A module path segment must be a Python identifier: `settings.local.py` (a dotted FILENAME) is
// not importable, yet naively indexes as module `settings.local` — a WRONG edge that shortest-path
// tie-breaking can prefer over a real `settings/local.py`. Extraction emits identifier-only
// specifiers, so rejecting non-identifier segments loses nothing valid ("never a wrong edge").
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const dirOf = (p: string): string => {
  const d = path.posix.dirname(p);
  return d === '.' ? '' : d;
};

/**
 * Derive module roots + the dotted-module index from the discovered fileSet alone — no fs reads,
 * no packaging-config parsing. Roots: the repo root, every `src/` segment, the parent of each
 * topmost `__init__.py` package (walk-up-while-`__init__.py`-exists), plus explicit extraRoots.
 * Deep PEP-420 namespace packages under a non-`src` nested root are the acknowledged gap (ADR-52):
 * their absolute imports go unresolved — a missing edge, never a wrong one.
 */
export function buildModuleIndex(
  fileSet: ReadonlySet<string>,
  extraRoots: readonly string[] = [],
): PyModuleIndex {
  const pyFiles = [...fileSet].filter((f) => f.endsWith('.py'));
  const packageDirs = new Set(pyFiles.filter((f) => path.posix.basename(f) === '__init__.py').map(dirOf));

  const roots = new Set<string>(['']);
  for (const r of extraRoots) roots.add(r.replace(/\/+$/, ''));
  for (const f of pyFiles) {
    const segs = f.split('/');
    for (let i = 0; i < segs.length - 1; i++) {
      if (segs[i] === 'src') roots.add(segs.slice(0, i + 1).join('/'));
    }
  }
  for (let dir of packageDirs) {
    while (packageDirs.has(dirOf(dir)) && dir !== '') dir = dirOf(dir);
    roots.add(dirOf(dir));
  }

  const index: PyModuleIndex = new Map();
  for (const root of roots) {
    const prefix = root === '' ? '' : root + '/';
    for (const f of pyFiles) {
      if (prefix && !f.startsWith(prefix)) continue;
      // Validate PATH segments BEFORE joining with '.' — after joining, the dot in a filename like
      // `settings.local.py` is indistinguishable from a package separator and would slip through.
      const parts = f.slice(prefix.length, -'.py'.length).split('/');
      if (parts[parts.length - 1] === '__init__') parts.pop();
      if (parts.length === 0) continue; // a root-level __init__.py names no module
      if (!parts.every((seg) => IDENT.test(seg))) continue; // unimportable path — never index it
      const mod = parts.join('.');
      const existing = index.get(mod);
      if (!existing) index.set(mod, [f]);
      else if (!existing.includes(f)) existing.push(f);
    }
  }
  return index;
}

function commonPrefixLen(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

/**
 * Resolve one Python import specifier (leading dots = relative level) to a repo-relative file in
 * `fileSet`; null for stdlib/third-party/unresolved. Deepest-first walk-down — the analog of the TS
 * `base → base+ext → base/index+ext` ladder with `__init__.py` as the index-file — which also settles
 * the `from pkg import name` submodule-vs-symbol ambiguity: `pkg/name.py` first, else `pkg/__init__.py`.
 */
export function resolvePythonImport(
  fromFile: string,
  spec: string,
  index: PyModuleIndex,
  fileSet: ReadonlySet<string>,
): string | null {
  if (spec.startsWith('.')) {
    let level = 0;
    while (spec[level] === '.') level++;
    const tail = spec.slice(level) === '' ? [] : spec.slice(level).split('.');
    let base = dirOf(fromFile);
    for (let i = 1; i < level; i++) {
      if (base === '') return null; // relative import escaping the repo root
      base = dirOf(base);
    }
    for (let k = tail.length; k >= 0; k--) {
      const p = [base, ...tail.slice(0, k)].filter(Boolean).join('/');
      // Package before module: Python's finder gives `m/__init__.py` precedence over a sibling `m.py`.
      const candidates = k > 0 ? [`${p}/__init__.py`, `${p}.py`] : [p === '' ? '__init__.py' : `${p}/__init__.py`];
      for (const c of candidates) {
        if (c !== fromFile && fileSet.has(c)) return c;
      }
    }
    return null;
  }

  const parts = spec.split('.');
  const isPackage = (f: string): number => (f.endsWith('/__init__.py') || f === '__init__.py' ? 1 : 0);
  for (let k = parts.length; k >= 1; k--) {
    const files = index.get(parts.slice(0, k).join('.'))?.filter((f) => f !== fromFile);
    if (!files || files.length === 0) continue;
    // Deterministic pick: same-package/same-root preference, then package over a same-named module
    // (Python's finder order), then shortest path, then lexicographic.
    return [...files].sort(
      (a, b) =>
        commonPrefixLen(b, fromFile) - commonPrefixLen(a, fromFile) ||
        isPackage(b) - isPackage(a) ||
        a.split('/').length - b.split('/').length ||
        (a < b ? -1 : 1),
    )[0]!;
  }
  return null;
}
