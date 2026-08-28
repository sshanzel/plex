import { slugify, hashId, remapAnchor, type Incident, type IncidentSource } from '@plex/core';
import type { KnowledgeStore } from './store';

/** Record a confirmed finding as a provenance incident linking a pitfall (ADR-10); returns the incident id. */
export async function recordIncident(
  store: KnowledgeStore,
  input: { source?: IncidentSource; repo?: string; file?: string; line?: number; symbol?: string; snippet?: string; outcome?: Incident['outcome']; pitfallId?: string; note?: string; verb?: 'reject' | 'waive'; findingId?: string; target?: string; ts: string },
): Promise<string> {
  // file slug + a content hash of the snippet, so distinct snippets never collide.
  const id = `inc:${slugify(input.file ?? 'x') || 'x'}:${hashId(input.snippet ?? '')}:${input.ts}`;
  const incident: Incident = {
    id,
    pitfallId: input.pitfallId,
    source: input.source ?? 'review',
    repo: input.repo,
    file: input.file,
    // Spread conditionally — only when present, to keep older incidents byte-identical.
    ...(input.line != null ? { line: input.line } : {}),
    ...(input.symbol ? { symbol: input.symbol } : {}),
    snippet: input.snippet,
    outcome: input.outcome,
    ...(input.note ? { note: input.note } : {}),
    ...(input.verb ? { verb: input.verb } : {}),
    // Provenance back to the review event (ADR-46) — only when present (analyzed incidents have none).
    ...(input.findingId ? { findingId: input.findingId } : {}),
    ...(input.target ? { target: input.target } : {}),
    ts: input.ts,
  };
  await store.addIncident(incident);
  return id;
}

/**
 * Re-anchor incident `file`/`symbol` across file renames (ADR-53) so code-path memory + suppression keep
 * matching at the new path. Pure. `renames` is old→new repo-relative POSIX. **Scoped to `repo`** — the
 * knowledge store is GLOBAL (`~/.plex/knowledge`, every repo's incidents), so only incidents tagged with
 * the current repo are eligible; without this a rename in one repo would rewrite another repo's incident
 * at the same relative path (e.g. `src/index.ts`). `id`/`pitfallId`/provenance are LEFT UNTOUCHED — the
 * id's file slug is cosmetic (nothing parses it back out) and rewriting it would sever pitfall provenance
 * (a dangling `incidentIds` is silently dropped). Returns the FULL set (so the caller can honor
 * `replaceIncidents`' full-set contract) plus `changed`, so a no-rename review skips the write.
 */
export function migrateIncidentAnchors(
  incidents: Incident[],
  renames: ReadonlyMap<string, string>,
  repo: string,
): { incidents: Incident[]; changed: boolean } {
  let changed = false;
  const out = incidents.map((i) => {
    if (i.repo !== repo) return i; // not this repo's incident — the global store holds every repo's
    const r = remapAnchor(renames, i.file, i.symbol);
    if (!r.changed) return i;
    changed = true;
    return {
      ...i,
      ...(i.file !== undefined ? { file: r.file } : {}),
      ...(i.symbol !== undefined ? { symbol: r.symbol } : {}),
    };
  });
  return { incidents: out, changed };
}
