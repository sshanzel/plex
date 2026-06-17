import { cosineSimilarity, cosineBackground, adaptiveFloor, type Pitfall } from '@plex/core';
import type { KnowledgeStore } from './store';
import { confidenceFromOutcomes } from './stats';
import { lexicalScores } from './retrieve';

// Same floors the engine's `inferPitfallId` (the live review-accept path) uses, so mining and live
// review treat "the same principle" identically. Lexical runs lower than cosine, hence the lower bar.
const SEMANTIC_FLOOR = 0.7;
const LEXICAL_FLOOR = 0.45;

export interface AddOrReinforceResult {
  action: 'minted' | 'reinforced';
  pitfallId: string;
}

const hasVector = (p: Pitfall): boolean => Array.isArray(p.embedding) && p.embedding.length > 0;

/**
 * Find the existing pitfall whose PRINCIPLE matches `candidate` — semantic first (cosine over stored
 * vectors), then exact-title (preserves the old `hasPitfallTitled` dedup as a strict subset), then
 * lexical over whatever the semantic pass could NOT judge. `eligible` is pre-filtered by scope +
 * polarity. Mirrors `inferPitfallId`, including the mixed-embedding case: a vectored candidate whose
 * eligible set has no vectors still falls through to lexical (so it isn't silently reduced to
 * exact-title), while a candidate that WAS compared semantically only lexical-checks the vectorless
 * remainder — a real semantic "not similar" is never overridden by keyword overlap.
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
  // Exact-title equality — runs for vectored and vectorless candidates alike, so this path is never
  // WORSE at deduping than the `hasPitfallTitled` check it replaces.
  const exact = eligible.find((p) => p.title === candidate.title);
  if (exact) return exact;
  // Lexical over the un-judged remainder: everything when no semantic comparison ran (vectorless
  // candidate OR no embedded pitfalls to compare against), else only the vectorless pitfalls.
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
 * Semantic match-or-reinforce for a mined pitfall (the write-time dedup that replaces exact-title
 * matching across `analyze` runs). Given a fully-formed candidate Pitfall (which already carries its
 * `embedding` when an embedding provider was available), find an in-scope existing pitfall whose
 * PRINCIPLE matches and **reinforce** it — union the provenance incidents, recompute confidence from
 * the merged evidence, bump `lastReinforcedAt` — instead of minting a duplicate. Mint only on a miss.
 *
 * "Common" is encoded as confidence: a first sighting mints low (often 0); each recurrence reinforces
 * and the Wilson lower bound tightens upward — the same `confidenceFromOutcomes` estimator mint uses.
 *
 * NOTE: confidence is recomputed INLINE here rather than deferred to `consolidatePitfalls`, because
 * analyzed incidents (`inc:analyzed:*`) carry no `pitfallId` back-reference, so consolidation can't
 * recompute their pitfall's confidence (it indexes incidents by `pitfallId`). Don't "simplify" this
 * by relying on consolidate — it would silently no-op for mined pitfalls.
 *
 * PRECONDITION: a candidate's provenance incidents must already be PERSISTED (`store.addIncident`)
 * before this is called — confidence is recomputed from `store.incidents()`, so an unpersisted
 * incidentId contributes provenance (it's unioned into `incidentIds`) but ABSTAINS in the Wilson
 * count. Both `analyze` write paths satisfy this: `scanHistory` records every `inc:analyzed:*` before
 * distill/`add_pitfalls` ever build a candidate.
 */
export async function addOrReinforcePitfall(
  store: KnowledgeStore,
  candidate: Pitfall,
): Promise<AddOrReinforceResult> {
  // Re-read every call: call sites loop and `replacePitfalls` rewrites the whole file, so a snapshot
  // cached across iterations would clobber an earlier iteration's reinforce/mint.
  const pitfalls = await store.pitfalls();
  const candPolarity = candidate.polarity ?? 'positive';
  const eligible = pitfalls.filter(
    (p) =>
      // Never merge across polarity (a positive lesson must not reinforce a suppression — confidence
      // semantics invert) or across repo scope (ADR-21 — repo A's lesson never feeds repo B).
      (p.polarity ?? 'positive') === candPolarity &&
      ((p.scope ?? 'global') !== 'repo' || p.repo === candidate.repo),
  );

  const matched = findMatch(candidate, eligible);
  if (!matched) {
    await store.addPitfall(candidate);
    return { action: 'minted', pitfallId: candidate.id };
  }

  const incidentIds = [...new Set([...matched.incidentIds, ...candidate.incidentIds])];
  const byId = new Map((await store.incidents()).map((i) => [i.id, i] as const));
  const confidence = confidenceFromOutcomes(incidentIds.map((id) => byId.get(id)?.outcome));
  // Newest evidence timestamp drives the retrieval recency tilt (mirrors `consolidatePitfalls`).
  let lastMs = 0;
  for (const id of incidentIds) {
    const ts = byId.get(id)?.ts;
    const ms = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(ms) && ms > lastMs) lastMs = ms;
  }
  const lastReinforcedAt = lastMs > 0 ? new Date(lastMs).toISOString() : matched.lastReinforcedAt;

  // Keep the matched pitfall's canonical text (title/why/mitigation/embedding/scope/repo) — the
  // established principle wins; the new sighting only grows evidence + confidence.
  const reinforced: Pitfall = { ...matched, incidentIds, confidence, lastReinforcedAt };
  await store.replacePitfalls(pitfalls.map((p) => (p.id === matched.id ? reinforced : p)));
  return { action: 'reinforced', pitfallId: matched.id };
}
