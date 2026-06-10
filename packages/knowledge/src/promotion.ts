import { outcomeWeight, type Incident } from '@plex/core';
import type { KnowledgeStore } from './store';
import { betaPosteriorMean } from './stats';

// Beta-Bernoulli model for pitfall confidence (tuning.md §1). Prior Beta(1,1) = Laplace's rule of
// succession (an untested pitfall sits at 0.5 once evidence arrives); rejects cost 1.5× a confirm
// (a false positive is dearer — this is the old +0.1/−0.15 asymmetry, now permanent and bounded).
const PRIOR_ALPHA = 1;
const PRIOR_BETA = 1;
const REJECT_COST = 1.5;

export interface ConsolidateResult {
  pitfalls: number;
  reinforced: number;
}

/**
 * Recompute pitfall confidence from linked incident outcomes — the feedback loop's
 * teeth (ADR-10). Accepted/fixed incidents strengthen a pitfall; rejected ones weaken
 * it. Pitfalls also accumulate their incident ids as provenance.
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
    // Beta-Bernoulli posterior mean over ALL linked outcomes, outcome-weighted (ADR-11):
    // accepted/fixed contribute 1, reverted 1.5 (`outcomeWeight` — the warned-against change
    // shipped and was later reverted: the strongest confirmation), rejected lands on the failure
    // side at REJECT_COST. Idempotent by construction — it's a pure function of the counts, so
    // re-running consolidate can't drift confidence the way the old additive rule did (no
    // applied-set ledger needed). Real accept/reject evidence supersedes the prior
    // estimate, which is what we want once a pitfall has a track record.
    const s = inc.reduce((sum, i) => sum + outcomeWeight(i.outcome), 0);
    const f = inc.filter((i) => i.outcome === 'rejected').length;
    const confidence = betaPosteriorMean(PRIOR_ALPHA + s, PRIOR_BETA + REJECT_COST * f);
    return { ...p, confidence, incidentIds: inc.map((i) => i.id) };
  });

  await store.replacePitfalls(next);
  return { pitfalls: pitfalls.length, reinforced };
}
