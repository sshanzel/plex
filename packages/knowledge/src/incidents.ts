import { slugify, hashId, type Incident, type IncidentSource } from '@plex/core';
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
