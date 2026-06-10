import { slugify, hashId, safeEmbed, type EmbeddingProvider, type Pitfall, type Incident, type IncidentSource } from '@plex/core';
import type { KnowledgeStore } from './store';

/** A collision-free pitfall id: a readable slug + a content hash of the full title. */
const pitfallId = (title: string): string => `pf:${slugify(title) || 'p'}-${hashId(title)}`;

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
      category = slugify(heading[1]!) || 'general';
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)/);
    if (bullet && bullet[1]!.length > 3) out.push({ title: bullet[1]!, category });
  }
  return out;
}

/**
 * Seed the knowledge base from markdown guidance. Returns the number of new pitfalls.
 * `provider` may be null (no embedding key configured): the pitfall is stored without a
 * vector and stays retrievable via the lexical path (`retrieveRelevantLexical` / the
 * hybrid branch of `retrieveRelevant`) — seeding must work on a key-less install.
 */
export async function seedFromMarkdown(
  store: KnowledgeStore,
  provider: EmbeddingProvider | null,
  md: string,
): Promise<number> {
  // Dedupe first, then embed as a batch THROUGH safeEmbed — it chunks under provider
  // batch caps (Voyage ~128 inputs, Gemini 100; a large plex.md would fail one raw
  // unchunked call) and degrades to null on a transient outage, so seeding falls back to
  // vectorless storage (lexically retrievable) instead of failing.
  const seen = new Set<string>();
  const fresh: ParsedPitfall[] = [];
  for (const it of parseMarkdownPitfalls(md)) {
    if (seen.has(it.title) || (await store.hasPitfallTitled(it.title))) continue;
    seen.add(it.title);
    fresh.push(it);
  }
  if (fresh.length === 0) return 0;
  const vecs = provider ? ((await safeEmbed(provider, fresh.map((it) => `${it.category}: ${it.title}`))) ?? []) : [];
  for (let i = 0; i < fresh.length; i++) {
    const it = fresh[i]!;
    const pitfall: Pitfall = {
      id: pitfallId(it.title),
      title: it.title,
      trigger: it.title,
      why: it.title,
      category: it.category,
      tier: 'judgmental',
      confidence: 0.4,
      scope: 'global',
      incidentIds: [],
      embedding: vecs[i],
    };
    await store.addPitfall(pitfall);
  }
  return fresh.length;
}

/**
 * Record a confirmed finding as an incident, and link/strengthen a pitfall (ADR-10:
 * the reviewer learns from its own confirmed discoveries). Returns the incident id.
 */
export async function recordIncident(
  store: KnowledgeStore,
  input: { source?: IncidentSource; repo?: string; file?: string; snippet?: string; outcome?: Incident['outcome']; pitfallId?: string; ts: string },
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
    ts: input.ts,
  };
  await store.addIncident(incident);
  return id;
}
