import { cosineSimilarity, cosineBackground, adaptiveFloor, type Pitfall } from '@plex/core';
import type { KnowledgeStore } from './store';
import { confidenceFromOutcomes } from './stats';
import { lexicalScores } from './retrieve';

// Same floors the engine's `inferPitfallId` uses, so mining and live review treat "the same principle" identically.
const SEMANTIC_FLOOR = 0.7;
const LEXICAL_FLOOR = 0.45;

export interface AddOrReinforceResult {
  action: 'minted' | 'reinforced';
  pitfallId: string;
  /** The CANONICAL stored title — on a reinforce this is the EXISTING pitfall's title, not the candidate's. */
  title: string;
  scope: 'global' | 'repo';
  /** Provenance incidents on the stored pitfall AFTER this op — the UNION on a reinforce, not just this run's sighting. */
  incidents: number;
  /** Distinct source files those incidents concern — the "anchored to N files" denominator. */
  files: number;
}

const hasVector = (p: Pitfall): boolean => Array.isArray(p.embedding) && p.embedding.length > 0;

/**
 * Find the existing pitfall whose PRINCIPLE matches `candidate` — semantic (cosine), then exact-title,
 * then lexical over the un-judged remainder. `eligible` is pre-filtered by scope + polarity. INVARIANT:
 * a candidate compared semantically only lexical-checks the vectorless remainder, so a real semantic
 * "not similar" is never overridden by keyword overlap.
 */
function findMatch(candidate: Pitfall, eligible: Pitfall[]): Pitfall | undefined {
  let judgedSemantically = false;
  if (hasVector(candidate)) {
    const embedded = eligible.filter(hasVector);
    if (embedded.length > 0) {
      judgedSemantically = true;
      const floor = adaptiveFloor(SEMANTIC_FLOOR, cosineBackground(embedded.map((p) => p.embedding!)));
      let best: { p: Pitfall; score: number } | undefined;
      for (const p of embedded) {
        const score = cosineSimilarity(candidate.embedding!, p.embedding!);
        if (score >= floor && (best === undefined || score > best.score)) best = { p, score };
      }
      if (best) return best.p;
    }
  }
  const exact = eligible.find((p) => p.title === candidate.title);
  if (exact) return exact;
  // Lexical over the un-judged remainder: everything when no semantic comparison ran, else only the vectorless pitfalls.
  const lexCandidates = judgedSemantically ? eligible.filter((p) => !hasVector(p)) : eligible;
  if (lexCandidates.length > 0) {
    const scores = lexicalScores(candidate.title, lexCandidates);
    let bi = -1;
    for (let i = 0; i < lexCandidates.length; i++) {
      if (scores[i]! >= LEXICAL_FLOOR && (bi < 0 || scores[i]! > scores[bi]!)) bi = i;
    }
    if (bi >= 0) return lexCandidates[bi];
  }
  return undefined;
}

/**
 * Semantic match-or-reinforce for a mined pitfall: match an in-scope existing pitfall whose PRINCIPLE
 * matches and reinforce it (union incidents, recompute confidence, bump `lastReinforcedAt`); mint on a miss.
 *
 * INVARIANT: confidence is recomputed INLINE here, not via `consolidatePitfalls` — analyzed incidents
 * (`inc:analyzed:*`) carry no `pitfallId`, so consolidate can't recompute their pitfall (it indexes by
 * `pitfallId`). Don't "simplify" by relying on consolidate — it would silently no-op for mined pitfalls.
 *
 * PRECONDITION: a candidate's provenance incidents must already be PERSISTED (`store.addIncident`) — confidence
 * is recomputed from `store.incidents()`, so an unpersisted incidentId contributes provenance but ABSTAINS in Wilson.
 */
export async function addOrReinforcePitfall(
  store: KnowledgeStore,
  candidate: Pitfall,
): Promise<AddOrReinforceResult> {
  // Re-read every call: call sites loop and `replacePitfalls` rewrites the whole file, so a cached
  // snapshot would clobber an earlier iteration's reinforce/mint.
  const pitfalls = await store.pitfalls();
  const incidentsById = new Map((await store.incidents()).map((i) => [i.id, i] as const));
  const fileCount = (ids: string[]): number => new Set(ids.map((id) => incidentsById.get(id)?.file).filter((f): f is string => !!f)).size;
  const normScope = (s: Pitfall['scope']): 'global' | 'repo' => (s === 'global' ? 'global' : 'repo');
  const candPolarity = candidate.polarity ?? 'positive';
  const eligible = pitfalls.filter(
    (p) =>
      // Never merge across polarity (confidence semantics invert) or across repo scope (ADR-21).
      (p.polarity ?? 'positive') === candPolarity &&
      ((p.scope ?? 'global') !== 'repo' || p.repo === candidate.repo),
  );

  const matched = findMatch(candidate, eligible);
  if (!matched) {
    await store.addPitfall(candidate);
    return {
      action: 'minted', pitfallId: candidate.id, title: candidate.title, scope: normScope(candidate.scope),
      incidents: candidate.incidentIds.length, files: fileCount(candidate.incidentIds),
    };
  }

  const incidentIds = [...new Set([...matched.incidentIds, ...candidate.incidentIds])];
  const confidence = confidenceFromOutcomes(incidentIds.map((id) => incidentsById.get(id)?.outcome));
  // Newest evidence timestamp drives the retrieval recency tilt.
  let lastMs = 0;
  for (const id of incidentIds) {
    const ts = incidentsById.get(id)?.ts;
    const ms = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(ms) && ms > lastMs) lastMs = ms;
  }
  const lastReinforcedAt = lastMs > 0 ? new Date(lastMs).toISOString() : matched.lastReinforcedAt;

  // Keep the matched pitfall's canonical text — the established principle wins; the sighting only grows evidence.
  const reinforced: Pitfall = { ...matched, incidentIds, confidence, lastReinforcedAt };
  await store.replacePitfalls(pitfalls.map((p) => (p.id === matched.id ? reinforced : p)));
  return {
    action: 'reinforced', pitfallId: matched.id, title: matched.title, scope: normScope(matched.scope),
    incidents: incidentIds.length, files: fileCount(incidentIds),
  };
}
