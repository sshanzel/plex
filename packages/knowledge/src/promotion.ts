import type { Incident, Pitfall } from '@plex/core';
import type { KnowledgeStore } from './store';
import { wilsonLowerBound } from './stats';

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
function confirmsAndRefutes(p: Pitfall, inc: Incident[]): { confirms: number; refutes: number } {
  const isAccepting = (o: Incident['outcome']): boolean => o === 'accepted' || o === 'fixed' || o === 'reverted';
  const negative = p.polarity === 'negative';
  let confirms = 0;
  let refutes = 0;
  for (const i of inc) {
    const accepting = isAccepting(i.outcome);
    // negative: a dismissal (rejected) confirms suppression; an accept refutes it. positive: reverse.
    if (negative ? i.outcome === 'rejected' : accepting) confirms++;
    else if (negative ? accepting : i.outcome === 'rejected') refutes++;
  }
  return { confirms, refutes };
}

export interface ConsolidateResult {
  pitfalls: number;
  reinforced: number;
}

/**
 * Recompute pitfall confidence from linked incident outcomes — the feedback loop's teeth (ADR-10).
 * Pitfalls also accumulate their incident ids as provenance. A pitfall with no incidents keeps its
 * prior confidence.
 */
export async function consolidatePitfalls(store: KnowledgeStore): Promise<ConsolidateResult> {
  const pitfalls = await store.pitfalls();
  const incidents = await store.incidents();
  const byPitfall = new Map<string, Incident[]>();
  for (const i of incidents) {
    if (!i.pitfallId) continue;
    const list = byPitfall.get(i.pitfallId) ?? [];
    list.push(i);
    byPitfall.set(i.pitfallId, list);
  }

  let reinforced = 0;
  const next = pitfalls.map((p) => {
    const inc = byPitfall.get(p.id) ?? [];
    if (inc.length === 0) return p; // no outcomes yet → keep the prior confidence
    reinforced++;
    const { confirms, refutes } = confirmsAndRefutes(p, inc);
    // For a NEGATIVE pitfall this `confidence` is INFORMATIONAL ONLY — the live ranking path
    // (`engine` `loadSuppressions`) recomputes the suppress/demote tier from raw incident counts so a
    // dismissal takes effect without a `consolidate` run, and never reads this stored value. It's kept
    // for provenance/visibility; don't mistake it for the active suppression strength.
    const confidence = wilsonLowerBound(confirms, confirms + refutes);
    return { ...p, confidence, incidentIds: inc.map((i) => i.id) };
  });

  await store.replacePitfalls(next);
  return { pitfalls: pitfalls.length, reinforced };
}
