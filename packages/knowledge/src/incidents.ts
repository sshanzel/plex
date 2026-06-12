import { slugify, hashId, type Incident, type IncidentSource } from '@plex/core';
import type { KnowledgeStore } from './store';

/**
 * Record a confirmed finding as an incident, and link/strengthen a pitfall (ADR-10:
 * the reviewer learns from its own confirmed discoveries). Returns the incident id.
 */
export async function recordIncident(
  store: KnowledgeStore,
  input: { source?: IncidentSource; repo?: string; file?: string; snippet?: string; outcome?: Incident['outcome']; pitfallId?: string; note?: string; verb?: 'reject' | 'waive'; ts: string },
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
    snippet: input.snippet,
    outcome: input.outcome,
    ...(input.note ? { note: input.note } : {}),
    ...(input.verb ? { verb: input.verb } : {}),
    ts: input.ts,
  };
  await store.addIncident(incident);
  return id;
}
