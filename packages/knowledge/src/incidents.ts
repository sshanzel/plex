import { slugify, hashId, type Incident, type IncidentSource } from '@plex/core';
import type { KnowledgeStore } from './store';

/**
 * Record a confirmed finding as an incident, and link/strengthen a pitfall (ADR-10:
 * the reviewer learns from its own confirmed discoveries). Returns the incident id.
 */
export async function recordIncident(
  store: KnowledgeStore,
  input: { source?: IncidentSource; repo?: string; file?: string; line?: number; symbol?: string; snippet?: string; outcome?: Incident['outcome']; pitfallId?: string; note?: string; verb?: 'reject' | 'waive'; findingId?: string; target?: string; ts: string },
): Promise<string> {
  // file (readable) + a content hash of the snippet (so distinct snippets never collide,
  // and a non-ASCII/empty snippet doesn't degrade to an empty, colliding segment).
  const id = `inc:${slugify(input.file ?? 'x') || 'x'}:${hashId(input.snippet ?? '')}:${input.ts}`;
  const incident: Incident = {
    id,
    pitfallId: input.pitfallId,
    source: input.source ?? 'review',
    repo: input.repo,
    file: input.file,
    // Code-path anchor (best-effort) — only when present, to keep older incidents byte-identical.
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
