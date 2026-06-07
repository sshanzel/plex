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
