/**
 * Stable `file#name` symbol key anchoring a concern to a code location (ADR-47, code-path memory).
 * Drift-tolerant by design: NOT `Symbol.id` (`file#name#startLine` breaks on line drift) and NOT bare
 * `name` (collides across files) — a moved symbol keeps its key, a renamed one becomes a new key.
 * Single source of truth so capture, match, and the viz join never disagree on "same symbol".
 */
export function symbolKey(file: string, name: string): string {
  return `${file}#${name}`;
}
