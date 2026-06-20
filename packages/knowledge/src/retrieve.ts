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

/** An analyzed-provenance incident id, EXACTLY `inc:analyzed:<commentId>` (commentId numeric → no
 *  further colon). Used to count recurrence without miscounting a review incident on a file slugged
 *  `analyzed` (`inc:analyzed:<hash>:<ts>`, which has extra colons). */
const ANALYZED_INCIDENT_ID = /^inc:analyzed:[^:]+$/;

/**
 * Recurrence tilt (ADR-49): `max(tiltFloor, n/(n+1))` where `n` is the pitfall's provenance-incident
 * count — how often the lesson was independently raised. Monotonic + saturating, so a long-recurring
 * lesson outranks a one-off at equal cosine. POSITIVE pitfalls only: a negative (suppression) pitfall's
 * strength is computed live in the engine from decayed dismissal counts, never from a retrieval tilt, so
 * it gets a neutral 1 here (no double-count). Pure. See the `rankAndSlim` header for the axis rationale
 * and the `Finding.prevalence` naming contrast.
 */
export function recurrenceWeight(p: Pitfall, tiltFloor: number): number {
  if ((p.polarity ?? 'positive') !== 'positive') return 1;
  // Count only ANALYZED-provenance incidents. `consolidatePitfalls` writes back the UNION of a pitfall's
  // incidents (forward `incidentIds` ∪ reverse-linked live `accept` incidents), so a plain
  // `incidentIds.length` would let accept VOLUME inflate recurrence — re-coupling it to the confidence
  // axis it's meant to be independent of (a live accept is the confidence signal). Analyzed incidents are
  // the independent "raised in history" events recurrence is about. The analyze pipeline mints exactly
  // `inc:analyzed:<commentId>` (commentId numeric → no further colon), so we match that EXACT shape
  // rather than a bare prefix: a review incident on a file that happens to slugify to `analyzed`
  // (`inc:analyzed:<hash>:<ts>` — extra colons) must NOT be miscounted as analyzed provenance.
  const n = (p.incidentIds ?? []).filter((id) => ANALYZED_INCIDENT_ID.test(id)).length;
  return Math.max(tiltFloor, n / (n + 1));
}

// Rank, floor, cap — and drop the embedding from the RESULT: it powers the cosine but no
// consumer ever reads it (the agent, CLI, and audit log use title/why/category/score). A
// `voyage-code-3` vector is 1024 floats ≈ 16KB serialized PER pitfall — returning topK of
// them ships ~80KB / tens of thousands of tokens into every review context that the model
// can't use. The stored pitfall keeps its vector; only the retrieved copy is slimmed.
// TWO bounded evidence-quality tilts GATE the cosine score (applied before the minScore cut), then a
// THIRD salience tilt RE-RANKS the survivors. All floored at `tiltFloor` (> 0, so no tilt zeroes a hit)
// and read-only/reversible (stored fields untouched).
//
// Gate tilts — recency & confidence — both scale the score AND participate in the `minScore` cut. They
// **compound**: a pitfall that is stale AND weakly-evidenced is discounted by up to `tiltFloor²` (0.25
// at the 0.5 default) and CAN fall below `minScore` and drop out — *intended* (a stale, weak lesson is
// genuinely less trustworthy; ADR-42). The floor bounds each axis, not the product.
//   • Recency (ADR-42): `max(tiltFloor, 0.5^(ageDays/halfLife))` from `lastReinforcedAt` — a stale
//     lesson ranks lower. Undated → ageDays 0 → weight 1 → tilt 1 (no change; preserves test corpora).
//   • Confidence (ADR-44): `max(tiltFloor, confidence)` — the Wilson-grounded evidence strength (one
//     estimator everywhere, see confidenceFromOutcomes/consolidatePitfalls), so among similarly-relevant
//     pitfalls the better-evidenced one wins. `?? 1` is a legacy-only safety net: every pitfall the
//     pipeline writes carries a numeric confidence (mint/add_pitfalls/consolidate all fill it), so a
//     missing value can only come from a hand-edited record — treated as neutral (1), never penalized.
//
// Re-rank tilt — recurrence — scales the sort/returned score but is DELIBERATELY EXCLUDED from the
// `minScore` cut (it gates on the pre-recurrence evidence score). Recurrence is a salience signal among
// VALID lessons, not a relevance/quality signal: a valid one-off must rank *below* a recurring lesson
// but must never be *erased* for being a one-off (and one-offs are common — `n=1 → tilt floor`, so
// gating on it would uniformly discount the whole corpus and push borderline-relevant hits under
// `minScore`, regressing recall). So recurrence promotes; it never buries.
//   • Recurrence (ADR-49): `max(tiltFloor, n/(n+1))` where `n` = the count of ANALYZED-provenance
//     incidents (`inc:analyzed:*`) — how often this lesson was independently raised across history.
//     Analyzed-only on purpose: `consolidate` unions live `accept` incidents into `incidentIds`, so a
//     raw length would let accept volume inflate recurrence and re-couple it to the confidence axis it
//     must stay independent of. UNLIKE confidence (did the fix land?), recurrence does NOT decay with
//     age, so it's the axis that surfaces a long-recurring lesson in a cold-started historical KB where
//     every confidence sits at the floor. n=0/1→floor, n=4→0.8, n=37→0.97 (saturating: ≥1
//     comments-per-PR slightly inflate n, but saturation caps the effect). POSITIVE
//     pitfalls only — a negative/suppression pitfall's strength comes from `loadSuppressions` (engine,
//     live decayed counts), never retrieval; a recurrence tilt there would double-count its dismissals.
//     NOTE: distinct from `Finding.prevalence` (findings/signal.ts) — that is repo-commonness 0..1 and
//     DEMOTES (a common style nit ranks lower); recurrence here is a historical count and PROMOTES.
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
      // `gate` = relevance × evidence-quality, the value the minScore cut sees. Recurrence multiplies
      // only the sort/returned `score`, so it re-ranks without ever cutting a valid one-off.
      const gate = r.score * recencyTilt * confidenceTilt;
      return { pitfall: r.pitfall, gate, score: gate * recurrenceWeight(r.pitfall, tiltFloor) };
    })
    .filter((r) => r.gate >= minScore)
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
