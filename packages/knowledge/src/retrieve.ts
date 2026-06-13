import { cosineSimilarity, type EmbeddingProvider, type Pitfall } from '@plex/core';
import type { KnowledgeStore } from './store';
import { recencyWeight } from './stats';

/** Decay defaults so existing 6-arg callers (and undated test corpora) behave exactly as before:
 *  an undated pitfall ages 0 days → `recencyWeight = 1` → `max(floor, 1) = 1` → score unchanged. */
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

/**
 * Tokenize for lexical matching: split camelCase (so `getUserId` matches "user id"),
 * lowercase, keep alphanumeric runs of ≥3 chars, drop stopwords.
 */
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
 * Cosine over IDF-weighted token sets between the query and each pitfall's text
 * (title + trigger + why + category). Pure; IDF is computed over the given pitfalls,
 * so rare terms discriminate and boilerplate terms don't. Scores land in 0..1 like
 * embedding cosine, but run lower — callers keep the same `minScore` floor.
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

// Rank, floor, cap — and drop the embedding from the RESULT: it powers the cosine but no
// consumer ever reads it (the agent, CLI, and audit log use title/why/category/score). A
// `voyage-code-3` vector is 1024 floats ≈ 16KB serialized PER pitfall — returning topK of
// them ships ~80KB / tens of thousands of tokens into every review context that the model
// can't use. The stored pitfall keeps its vector; only the retrieved copy is slimmed.
// Two bounded, multiplicative tilts applied to the cosine score BEFORE the minScore cut — each floored
// at `tiltFloor` (> 0, so neither tilt ever ZEROES a hit) and both read-only/reversible (stored fields
// untouched). They are **independent axes and COMPOUND**: a pitfall that is BOTH stale AND
// weakly-evidenced is discounted by up to `tiltFloor²` (0.25 at the 0.5 default), which is *intended* —
// the stale-and-weak combination should rank lowest. The floor bounds each axis, not the product, so
// "never buries" means **never zeroed and never the sole reason a strongly-relevant hit is cut** — NOT
// "loses at most tiltFloor": a low-cosine, stale, weak pitfall CAN fall below `minScore` and drop out
// (the same intended ADR-42 drop-out behavior for the recency axis alone, now possible via either axis).
//   • Recency (ADR-42): `max(tiltFloor, 0.5^(ageDays/halfLife))` from `lastReinforcedAt` — a stale
//     lesson ranks lower. Undated → ageDays 0 → weight 1 → tilt 1 (no change; preserves test corpora).
//   • Confidence (ADR-44): `max(tiltFloor, confidence)` — the Wilson-grounded evidence strength (one
//     estimator everywhere, see confidenceFromOutcomes/consolidatePitfalls), so among similarly-relevant
//     pitfalls the better-evidenced one wins; a pitfall with NO confidence (legacy/seeded) uses 1
//     (neutral — never penalized for missing data).
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
      return { pitfall: r.pitfall, score: r.score * recencyTilt * confidenceTilt };
    })
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ pitfall: { embedding: _embedding, ...pitfall }, score }) => ({ pitfall, score }));

/**
 * Retrieve the pitfalls most relevant to a query (the diff's changed symbols, files, and
 * deterministic findings), ranked by embedding cosine similarity (ADR-01: grounded
 * retrieval, not fine-tuning).
 *
 * Hybrid: pitfalls stored WITHOUT a vector (seeded while no provider was configured) are
 * scored lexically instead of being invisible, and if the query embedding itself fails
 * (provider outage) the whole batch degrades to lexical rather than failing the review.
 *
 * Scope (ADR-21): global pitfalls always apply; repo-scoped pitfalls apply only when
 * reviewing their origin `repo`, so project-specific knowledge helps within that project
 * without polluting others.
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
    // Outage path: ONE lexical pass over the whole in-scope corpus — scoring embedded and
    // vectorless pitfalls against separate IDF bases would make the merged ranking
    // apples-to-oranges.
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

/**
 * Retrieval without any embedding provider: IDF-weighted token overlap over every
 * in-scope pitfall's text. Far weaker than embeddings, far better than nothing — a
 * key-less install still gets its accumulated pitfalls back.
 */
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
