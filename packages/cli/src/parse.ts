export interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Minimal argv parser. Supports `--flag value`, `--flag=value`, and a bare `--flag`
 * (boolean true); everything else is a positional. A `--flag` whose following token starts
 * with `--` is treated as boolean (you can't pass a value that itself begins with `--`).
 */
export function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1); // --flag=value (value may be empty)
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next; // --flag value
        i++;
      } else {
        flags[body] = true; // bare --flag
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

/** Thrown by `finiteFlag` when a numeric flag's value isn't a finite number — caught at the run() edge. */
export class FlagError extends Error {}

/**
 * Coerce a numeric flag value, rejecting anything that isn't finite. A bare `Number('abc')` yields
 * `NaN`, which then flows silently into the engine — `slice(0, NaN)` is 0 PRs, `clusterThreshold = NaN`
 * clusters nothing — and the command exits 0 having quietly done nothing (#3 silent-failure audit).
 * Surfacing it as a `FlagError` turns a silent no-op into an actionable non-zero exit.
 */
export function finiteFlag(raw: string, name: string): number {
  // `Number('')` and `Number('  ')` are 0 (finite) — a blank value is a user error, not zero. Reject it
  // explicitly so `--limit ''` doesn't silently mean `--limit 0`.
  const n = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) throw new FlagError(`--${name} must be a finite number (got "${raw}")`);
  return n;
}
