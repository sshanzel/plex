import type { EmbeddingProvider, Pitfall, Incident, IncidentSource } from '@plex/core';
import type { KnowledgeStore } from './store';

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

export interface ParsedPitfall {
  title: string;
  category: string;
}

/**
 * Parse `plex.md`-style markdown into seed pitfalls: `##` headings set the category,
 * `-`/`*` bullets become pitfalls (ADR-09 cold start).
 */
export function parseMarkdownPitfalls(md: string): ParsedPitfall[] {
  const out: ParsedPitfall[] = [];
  let category = 'general';
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.*)/);
    if (heading) {
      category = slug(heading[1]!) || 'general';
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)/);
    if (bullet && bullet[1]!.length > 3) out.push({ title: bullet[1]!, category });
  }
  return out;
}

/** Seed the knowledge base from markdown guidance. Returns the number of new pitfalls. */
export async function seedFromMarkdown(
  store: KnowledgeStore,
  provider: EmbeddingProvider,
  md: string,
): Promise<number> {
  const items = parseMarkdownPitfalls(md);
  let added = 0;
  for (const it of items) {
    if (await store.hasPitfallTitled(it.title)) continue;
    const [embedding] = await provider.embed([`${it.category}: ${it.title}`]);
    const pitfall: Pitfall = {
      id: `pf:${slug(it.title)}`,
      title: it.title,
      trigger: it.title,
      why: it.title,
      category: it.category,
      tier: 'judgmental',
      confidence: 0.4,
      scope: 'global',
      incidentIds: [],
      embedding,
    };
    await store.addPitfall(pitfall);
    added++;
  }
  return added;
}

/**
 * Record a confirmed finding as an incident, and link/strengthen a pitfall (ADR-10:
 * the reviewer learns from its own confirmed discoveries). Returns the incident id.
 */
export async function recordIncident(
  store: KnowledgeStore,
  input: { source?: IncidentSource; repo?: string; file?: string; snippet?: string; outcome?: Incident['outcome']; pitfallId?: string; ts: string },
): Promise<string> {
  const id = `inc:${slug(input.file ?? 'x')}:${slug(input.snippet ?? '')}:${input.ts}`;
  const incident: Incident = {
    id,
    pitfallId: input.pitfallId,
    source: input.source ?? 'review',
    repo: input.repo,
    file: input.file,
    snippet: input.snippet,
    outcome: input.outcome,
    ts: input.ts,
  };
  await store.addIncident(incident);
  return id;
}
