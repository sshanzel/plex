export interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Minimal argv parser: `--flag value`, `--flag=value`, bare `--flag` (boolean); else positional. A
 *  `--flag` followed by a `--`-prefixed token is boolean (can't pass a value that begins with `--`). */
export function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

/** Thrown by `finiteFlag` when a numeric flag's value isn't a finite number — caught at the run() edge. */
export class FlagError extends Error {}

/** Coerce a numeric flag value, rejecting non-finite input as a `FlagError` (a NaN would otherwise
 *  flow silently into the engine and no-op the command at exit 0). */
export function finiteFlag(raw: string, name: string): number {
  // `Number('')`/`Number('  ')` are finite 0 — reject blank explicitly so `--limit ''` isn't `--limit 0`.
  const n = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) throw new FlagError(`--${name} must be a finite number (got "${raw}")`);
  return n;
}
