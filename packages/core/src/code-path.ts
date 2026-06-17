/**
 * Code-path memory (ADR — location-aware retrieval): the single source of truth for the **stable
 * symbol key** that anchors a recorded concern to a code location.
 *
 * `file#name` — deliberately NOT the code graph's `Symbol.id` (`file#name#startLine`, which embeds the
 * line and so breaks on the exact drift we want to tolerate) and NOT the bare `name` (which collides
 * across files and can't be joined back to a file in the viz). A symbol that MOVES keeps its key; a
 * symbol that is RENAMED genuinely becomes a different key. Capture (engine), match (engine), and the
 * viz join all route through this one function so they can never disagree on what "same symbol" means.
 */
export function symbolKey(file: string, name: string): string {
  return `${file}#${name}`;
}
