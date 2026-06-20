import { cosineSimilarity, type EmbeddingProvider, type Pitfall } from '@plex/core';
import type { KnowledgeStore } from './store';
import { recencyWeight } from './stats';

// Decay defaults; an undated pitfall ages 0 days → `recencyWeight = 1` → score unchanged (back-compat).
const DECAY_HALF_LIFE_DAYS = 365;
const RETRIEVAL_TILT_FLOOR = 0.5;

export interface RetrievedPitfall {
  pitfall: Pitfall;
  score: number;
}

// Words that match every query without carrying meaning for review knowledge.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'not', 'with', 'this', 'that', 'from', 'into', 'when', 'then',
  'else', 'are', 'was', 'were', 'has', 'have', 'had', 'can', 'will', 'should', 'must',
  'never', 'always', 'use', 'using', 'used', 'your', 'our', 'its', 'all', 'any', 'each',
]);

/** Tokenize for lexical matching: split camelCase, lowercase, keep alphanumeric runs of ≥3 chars, drop stopwords. */
export function lexicalTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

const pitfallText = (p: Pitfall): string =>
  [p.title, p.trigger, p.why, p.category].filter(Boolean).join(' ');

/**
 * Cosine over IDF-weighted token sets between the query and each pitfall's text (title + trigger + why
 * + category). Scores land in 0..1 like embedding cosine, but run lower — callers keep the same `minScore`.
 */
export function lexicalScores(queryText: string, pitfalls: Pitfall[]): number[] {
  const docs = pitfalls.map((p) => lexicalTokens(pitfallText(p)));
  const q = lexicalTokens(queryText);
  const n = docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string): number => Math.log(1 + (n + 1) / (1 + (df.get(t) ?? 0)));
  const norm = (tokens: Set<string>): number =>
    Math.sqrt([...tokens].reduce((s, t) => s + idf(t) ** 2, 0));
  const qNorm = norm(q);
  return docs.map((d) => {
    if (q.size === 0 || d.size === 0 || qNorm === 0) return 0;
    let dot = 0;
    for (const t of d) if (q.has(t)) dot += idf(t) ** 2;
    return dot / (qNorm * norm(d));
  });
}

/** Scope filter (ADR-21): global pitfalls always apply; repo-scoped only in their origin repo. */
const inScope = (p: Pitfall, repo?: string): boolean =>
  (p.scope ?? 'global') !== 'repo' || p.repo === repo;

/** An analyzed-provenance incident id, EXACTLY `inc:analyzed:<commentId>`. Matched as an exact shape (not a
 *  prefix) so a review incident on a file slugged `analyzed` (`inc:analyzed:<hash>:<ts>`) isn't miscounted. */
const ANALYZED_INCIDENT_ID = /^inc:analyzed:[^:]+$/;

/**
 * Recurrence tilt (ADR-49): `max(tiltFloor, n/(n+1))`, `n` = analyzed-incident count — how often the
 * lesson was independently raised. POSITIVE pitfalls only (a negative pitfall's strength is computed
 * live in the engine; neutral 1 here to avoid double-count).
 */
export function recurrenceWeight(p: Pitfall, tiltFloor: number): number {
  if ((p.polarity ?? 'positive') !== 'positive') return 1;
  // Count ONLY analyzed incidents: `consolidate` unions live `accept` incidents into `incidentIds`, so a
  // plain length would let accept volume inflate recurrence — re-coupling it to the confidence axis.
  const n = (p.incidentIds ?? []).filter((id) => ANALYZED_INCIDENT_ID.test(id)).length;
  return Math.max(tiltFloor, n / (n + 1));
}

// Rank, floor, cap — and strip the embedding from the RESULT (a voyage-code-3 vector ≈ 16KB/pitfall; no
// consumer reads it). The stored pitfall keeps its vector; only the retrieved copy is slimmed.
//
// TWO evidence-quality GATE tilts scale the score AND participate in the `minScore` cut; a THIRD salience
// tilt RE-RANKS survivors. All floored at `tiltFloor` (> 0, so no tilt zeroes a hit); stored fields untouched.
//   • Recency (ADR-42): `max(tiltFloor, 0.5^(ageDays/halfLife))` from `lastReinforcedAt`. Undated → tilt 1.
//   • Confidence (ADR-44): `max(tiltFloor, confidence)` — Wilson-grounded. `?? 1` neutral for a hand-edited record.
//   The gate tilts COMPOUND: a stale-AND-weak pitfall is discounted up to `tiltFloor²` and CAN drop below `minScore` — intended.
//   • Recurrence (ADR-49): `max(tiltFloor, n/(n+1))`, `n` = ANALYZED-incident count. EXCLUDED from the
//     `minScore` cut (gates on the pre-recurrence score) — it promotes a recurring lesson without ever
//     erasing a valid one-off (one-offs sit at the floor; gating on it would regress recall). Does NOT
//     decay, so it surfaces long-recurring lessons in a cold-started KB. POSITIVE pitfalls only.
//     Distinct from `Finding.prevalence` (repo-commonness, which DEMOTES); recurrence is a count that PROMOTES.
const rankAndSlim = (
  scored: RetrievedPitfall[],
  topK: number,
  minScore: number,
  nowMs: number,
  halfLifeDays: number,
  tiltFloor: number,
): RetrievedPitfall[] =>
  scored
    .map((r) => {
      const t = r.pitfall.lastReinforcedAt ? Date.parse(r.pitfall.lastReinforcedAt) : NaN;
      const ageDays = Number.isNaN(t) ? 0 : (nowMs - t) / 86_400_000;
      const recencyTilt = Math.max(tiltFloor, recencyWeight(ageDays, halfLifeDays));
      const confidenceTilt = Math.max(tiltFloor, r.pitfall.confidence ?? 1);
      // `gate` = the value the minScore cut sees; recurrence multiplies only the sort/returned `score`.
      const gate = r.score * recencyTilt * confidenceTilt;
      return { pitfall: r.pitfall, gate, score: gate * recurrenceWeight(r.pitfall, tiltFloor) };
    })
    .filter((r) => r.gate >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ pitfall: { embedding: _embedding, ...pitfall }, score }) => ({ pitfall, score }));

/**
 * Retrieve the pitfalls most relevant to a query, ranked by embedding cosine similarity (ADR-01).
 * Hybrid: vectorless pitfalls are scored lexically, and a query-embed failure degrades the whole batch
 * to lexical rather than failing the review. Scope (ADR-21): global always; repo-scoped only for their origin repo.
 */
export async function retrieveRelevant(
  store: KnowledgeStore,
  provider: EmbeddingProvider,
  queryText: string,
  topK = 5,
  minScore = 0.05,
  repo?: string,
  now: Date = new Date(),
  halfLifeDays: number = DECAY_HALF_LIFE_DAYS,
  retrievalTiltFloor: number = RETRIEVAL_TILT_FLOOR,
): Promise<RetrievedPitfall[]> {
  const pitfalls = (await store.pitfalls()).filter((p) => inScope(p, repo));
  if (pitfalls.length === 0 || queryText.trim() === '') return [];
  const nowMs = now.getTime();
  let q: number[] | undefined;
  try {
    [q] = await provider.embed([queryText]);
  } catch {
    q = undefined; // transient provider failure → lexical for everything, never a failed review
  }
  if (!q) {
    // Outage path: ONE lexical pass over the whole corpus — separate IDF bases would make the merged ranking apples-to-oranges.
    const lex = lexicalScores(queryText, pitfalls);
    return rankAndSlim(pitfalls.map((pitfall, i) => ({ pitfall, score: lex[i]! })), topK, minScore, nowMs, halfLifeDays, retrievalTiltFloor);
  }
  const qv = q;
  const embedded = pitfalls.filter((p) => p.embedding && p.embedding.length > 0);
  const vectorless = pitfalls.filter((p) => !p.embedding || p.embedding.length === 0);
  const scored: RetrievedPitfall[] = embedded.map((pitfall) => ({ pitfall, score: cosineSimilarity(qv, pitfall.embedding!) }));
  const lex = lexicalScores(queryText, vectorless);
  scored.push(...vectorless.map((pitfall, i) => ({ pitfall, score: lex[i]! })));
  return rankAndSlim(scored, topK, minScore, nowMs, halfLifeDays, retrievalTiltFloor);
}

/** Retrieval without any embedding provider: IDF-weighted token overlap over every in-scope pitfall's text. */
export async function retrieveRelevantLexical(
  store: KnowledgeStore,
  queryText: string,
  topK = 5,
  minScore = 0.05,
  repo?: string,
  now: Date = new Date(),
  halfLifeDays: number = DECAY_HALF_LIFE_DAYS,
  retrievalTiltFloor: number = RETRIEVAL_TILT_FLOOR,
): Promise<RetrievedPitfall[]> {
  const pitfalls = (await store.pitfalls()).filter((p) => inScope(p, repo));
  if (pitfalls.length === 0 || queryText.trim() === '') return [];
  const lex = lexicalScores(queryText, pitfalls);
  return rankAndSlim(pitfalls.map((pitfall, i) => ({ pitfall, score: lex[i]! })), topK, minScore, now.getTime(), halfLifeDays, retrievalTiltFloor);
}
