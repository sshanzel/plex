import type { Incident, Pitfall } from '@plex/core';
import type { KnowledgeStore } from './store';
import { wilsonLowerBound, recencyWeight, CORROBORATED_WEIGHT } from './stats';
import { buildKnowledgeGraph, historyOf } from './graph';

/** Decay knobs consolidation needs (a subset of `config.decay`). */
export interface DecayParams {
  halfLifeDays: number;
  pruneFloor: number;
  pruneMinAgeDays: number;
}

const MS_PER_DAY = 86_400_000;
/** Age in days of an incident at `nowMs`; an unparseable/missing `ts` → 0 (full weight, never NaN). */
const ageDaysOf = (ts: string, nowMs: number): number => {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : (nowMs - t) / MS_PER_DAY;
};
/** Most recent incident `ts` (epoch ms), or 0 if none parse. */
const lastIncidentMs = (inc: Incident[]): number =>
  inc.reduce((max, i) => {
    const t = Date.parse(i.ts);
    return Number.isNaN(t) ? max : Math.max(max, t);
  }, 0);

/**
 * Tally confirms/refutes of a pitfall's claim, recency-weighted (the Wilson lower bound is taken by the
 * caller). The claim flips with polarity:
 *  - **positive** pitfall — CONFIRM is accept/fix/revert, refute is reject.
 *  - **negative** pitfall (suppression, docs/design/negative-knowledge.md) — CONFIRM is a dismissal
 *    (reject/waive logged `rejected`), refute is the user acting on it (accept/fix/revert).
 */
function confirmsAndRefutes(
  p: Pitfall,
  inc: Incident[],
  nowMs: number,
  halfLifeDays: number,
): { confirms: number; refutes: number } {
  // `corroborated` (ADR-50) is a WEAK accepting outcome — fractionally weighted; every other outcome is 1.
  const isAccepting = (o: Incident['outcome']): boolean =>
    o === 'accepted' || o === 'fixed' || o === 'reverted' || o === 'corroborated';
  const outcomeWeight = (o: Incident['outcome']): number => (o === 'corroborated' ? CORROBORATED_WEIGHT : 1);
  const negative = p.polarity === 'negative';
  let confirms = 0;
  let refutes = 0;
  for (const i of inc) {
    // Recency-weight (ADR-42); NaN ts → ageDays 0 → weight 1, so undated incidents behave as an unweighted count.
    const w = recencyWeight(ageDaysOf(i.ts, nowMs), halfLifeDays) * outcomeWeight(i.outcome);
    const accepting = isAccepting(i.outcome);
    // negative: a dismissal (rejected) confirms suppression; an accept refutes it. positive: reverse.
    if (negative ? i.outcome === 'rejected' : accepting) confirms += w;
    else if (negative ? accepting : i.outcome === 'rejected') refutes += w;
  }
  return { confirms, refutes };
}

export interface ConsolidateResult {
  pitfalls: number;
  reinforced: number;
  /** Pitfalls dropped because their decayed confidence fell below the floor AND they went quiet (ADR-42). */
  pruned: number;
}

/**
 * Recompute pitfall confidence from linked incident outcomes — the feedback loop's teeth (ADR-10),
 * recency-decayed (ADR-42). A pitfall with no incidents keeps its prior confidence and is never pruned
 * (ADR-11). Pruning drops only the derived record (incidents survive) when decayed confidence < `pruneFloor`,
 * the last incident is older than `pruneMinAgeDays`, and it is non-repo-scoped.
 *
 * `now` is injected so the decay is deterministic in tests — never `Date.now()`.
 */
export async function consolidatePitfalls(
  store: KnowledgeStore,
  decay: DecayParams,
  now: Date = new Date(),
): Promise<ConsolidateResult> {
  const nowMs = now.getTime();
  const pitfalls = await store.pitfalls();
  const incidents = await store.incidents();
  // Group via the in-memory graph, which UNIONS both link directions — so analyzed pitfalls (incidents
  // carry no `pitfallId`) are seen too, not just reverse-linked live accepts.
  const g = buildKnowledgeGraph(pitfalls, incidents);

  let reinforced = 0;
  let pruned = 0;
  const next: Pitfall[] = [];
  for (const p of pitfalls) {
    const inc = historyOf(g, p.id);
    if (inc.length === 0) {
      next.push(p); // no outcomes yet → keep the prior confidence; never pruned (ADR-11)
      continue;
    }
    const { confirms, refutes } = confirmsAndRefutes(p, inc, nowMs, decay.halfLifeDays);
    if (confirms + refutes === 0) {
      // Incidents exist but ALL abstain (ADR-44) or fully decayed: no evidence either way. Keep the prior
      // and never prune — wilsonLowerBound(0,0)=0 would crush it to a confident-wrong floor.
      next.push(p);
      continue;
    }
    reinforced++;
    // For a NEGATIVE pitfall this `confidence` is INFORMATIONAL ONLY — the live ranking path
    // (`engine` `loadSuppressions`) recomputes the tier from raw counts and never reads this stored value.
    const confidence = wilsonLowerBound(confirms, confirms + refutes);
    const lastMs = lastIncidentMs(inc);
    // The `refutes > 0` gate is load-bearing: prune only a lesson actually CONTRADICTED, not merely
    // thin — the decayed Wilson bound penalizes thinness, so without it a real-but-rare, never-refuted
    // lesson (Wilson ≈ 0.06) would be deleted despite a 100% confirm rate. Incidents survive the prune.
    const quietDays = lastMs > 0 ? (nowMs - lastMs) / MS_PER_DAY : 0;
    if (refutes > 0 && confidence < decay.pruneFloor && quietDays > decay.pruneMinAgeDays && p.scope !== 'repo') {
      pruned++;
      continue;
    }
    next.push({
      ...p,
      confidence,
      incidentIds: inc.map((i) => i.id),
      ...(lastMs > 0 ? { lastReinforcedAt: new Date(lastMs).toISOString() } : {}),
    });
  }

  await store.replacePitfalls(next);
  return { pitfalls: pitfalls.length, reinforced, pruned };
}
