import type { Incident, Pitfall } from '@plex/core';
import type { KnowledgeStore } from './store';
import { wilsonLowerBound, recencyWeight } from './stats';
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
 * Pitfall confidence = the **Wilson score lower bound** of the rate at which the evidence CONFIRMS
 * the pitfall's claim (Wilson 1927; the same primitive `suppressionTier` uses). One method for both
 * polarities, no hand-tuned constants — no Beta prior to pick, no `REJECT_COST` multiplier, no
 * `outcomeWeight` 1.5s. The lower bound is conservative by construction: a thin record stays low and
 * tightens toward the raw rate only as evidence accrues, so confidence is an *honest* floor rather
 * than an over-confident point estimate (and it's a pure function of the counts → idempotent, the
 * property the old additive rule lacked).
 *
 * The claim flips with polarity:
 *  - **positive** pitfall ("this is a real issue") — a CONFIRM is accept/fix/revert, a refute is reject.
 *  - **negative** pitfall ("suppress this", docs/design/negative-knowledge.md) — a CONFIRM is a
 *    dismissal (reject/waive logged as `rejected`), a refute is the user acting on it (accept/fix/revert).
 */
function confirmsAndRefutes(
  p: Pitfall,
  inc: Incident[],
  nowMs: number,
  halfLifeDays: number,
): { confirms: number; refutes: number } {
  const isAccepting = (o: Incident['outcome']): boolean => o === 'accepted' || o === 'fixed' || o === 'reverted';
  const negative = p.polarity === 'negative';
  let confirms = 0;
  let refutes = 0;
  for (const i of inc) {
    // Recency-weight (ADR-42): a lesson that stopped recurring fades. NaN ts → ageDays 0 → weight 1,
    // so undated incidents (e.g. test corpora) behave exactly as the old unweighted count.
    const w = recencyWeight(ageDaysOf(i.ts, nowMs), halfLifeDays);
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
 * now **recency-decayed** (ADR-42): each incident's confirm/refute contribution is weighted by
 * `recencyWeight(ageDays, halfLifeDays)` before the Wilson lower bound (which takes the fractional
 * counts unchanged), so a lesson that stopped recurring fades. Pitfalls also accumulate their incident
 * ids + `lastReinforcedAt` as provenance. A pitfall with no incidents keeps its prior confidence (and
 * is never pruned — ADR-11). **Pruning** drops a pitfall whose decayed confidence is below `pruneFloor`
 * AND whose last incident is older than `pruneMinAgeDays` AND that is non-repo-scoped — only the derived
 * pitfall record; its provenance Incidents stay in `incidents.jsonl`, so it is re-derivable.
 *
 * `now` is injected (default `new Date()`) so the decay is deterministic in tests — never `Date.now()`.
 */
export async function consolidatePitfalls(
  store: KnowledgeStore,
  decay: DecayParams,
  now: Date = new Date(),
): Promise<ConsolidateResult> {
  const nowMs = now.getTime();
  const pitfalls = await store.pitfalls();
  const incidents = await store.incidents();
  // Group via the in-memory graph, which UNIONS both link directions — so a pitfall's incidents are
  // seen whether linked forward (`incidentIds`, analyzed/distilled) or reverse (`incident.pitfallId`,
  // live accepts). Previously this read only the reverse side, so analyzed pitfalls (whose incidents
  // carry no `pitfallId`) were never reinforced/decayed here. (graph.ts)
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
      // The incidents exist but are ALL abstentions (observed-but-uninformative outcomes — see
      // confidenceFromOutcomes) or have fully decayed to ~0 weight: no evidence either way. Treat
      // exactly like "no outcomes yet" — keep the prior confidence and never prune. Without this,
      // wilsonLowerBound(0, 0) = 0 would crush a pitfall to zero confidence purely for being
      // unverifiable, which is the opposite of "honest floor" (it's a confident *wrong* floor).
      next.push(p);
      continue;
    }
    reinforced++;
    // For a NEGATIVE pitfall this `confidence` is INFORMATIONAL ONLY — the live ranking path
    // (`engine` `loadSuppressions`) recomputes the suppress/demote tier from raw incident counts so a
    // dismissal takes effect without a `consolidate` run, and never reads this stored value. It's kept
    // for provenance/visibility; don't mistake it for the active suppression strength.
    const confidence = wilsonLowerBound(confirms, confirms + refutes);
    const lastMs = lastIncidentMs(inc);
    // Prune only a lesson that has actually been CONTRADICTED (`refutes > 0`) AND decayed below the
    // floor AND gone quiet AND is non-repo-scoped. The `refutes > 0` gate is load-bearing: the decayed
    // Wilson lower bound penalizes sample *thinness* regardless of confirm rate, so without it a
    // real-but-rare, NEVER-refuted lesson (1 confirm, last seen >1y ago → Wilson ≈ 0.06) would be
    // deleted despite a 100% confirm rate. A never-refuted dormant lesson isn't garbage — it's just
    // quiet, and the retrieval recency-tilt already ranks it low; only a lesson the user has rejected
    // is a prune candidate. Only the derived pitfall is dropped — incidents stay (provenance survives).
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
