import {
  symbolKey,
  type CodeLocation,
  type Incident,
  type IncidentOutcome,
  type NeighborEntry,
} from '@plex/core';
import { rangesOverlap } from '@plex/neighborhood';
import { historyOf, type KnowledgeGraph, type RetrievedPitfall } from '@plex/knowledge';

/**
 * Code-path memory — the location-aware overlay on semantic retrieval (ADR — code-path memory).
 *
 * Semantic retrieval answers "is this lesson textually similar to your diff?". This module answers
 * the question a stateless linter cannot: **"has THIS code path had this concern before — and did we
 * fix it?"** It intersects the pitfalls' provenance incidents (anchored to a `file#name` symbol key
 * and/or a line) against the symbols a diff is actually touching (`nb.changed`) and their co-change
 * neighbours (`nb.neighbors`). The sharpest output is the **regression sentinel**: a prior `fixed`
 * (or accepted/reverted) outcome at a symbol you're changing again.
 *
 * PURE — no Kùzu, no embeddings, no I/O. It runs over the JSON knowledge store + the already-computed
 * neighbourhood (graph closed), so it adds no review-time graph open (ADR-17) and works on a key-less
 * install. Unit-tested with plain fixtures.
 */

export type CodePathKind = 'direct' | 'coupled';
/** How an incident was matched to the change — strongest (most precise) first. */
export type CodePathVia = 'symbol-key' | 'line-overlap' | 'file' | 'coupled-file';

export interface CodePathAlert {
  pitfallId: string;
  pitfallTitle: string;
  kind: CodePathKind;
  file: string;
  /** The symbol name being touched — set on DIRECT symbol matches, absent on file/coupled matches. */
  symbol?: string;
  /** Strongest prior outcome among the matched incidents (`fixed` > `accepted` > `reverted` > `rejected`). */
  priorOutcome?: IncidentOutcome;
  /** A prior fix/accept at a symbol now being changed again — the headline "don't regress this" signal. */
  regressionSentinel: boolean;
  via: CodePathVia;
  /** Up to `maxIncidentsPerAlert` provenance incident ids (the history behind this alert). */
  incidentIds: string[];
  /** Ranking boost this alert contributes to its pitfall (folded by `applyCodePathBoost`). */
  boost: number;
}

export interface CodePathResult {
  alerts: CodePathAlert[];
  /** Max boost per pitfall id — fold into the retrieval score with `applyCodePathBoost`. */
  boostByPitfall: Map<string, number>;
}

const OUTCOME_RANK: Record<string, number> = { fixed: 4, accepted: 3, reverted: 2, rejected: 1 };
const SENTINEL_OUTCOMES = new Set<IncidentOutcome>(['fixed', 'accepted', 'reverted']);

// Boost weights (docs/design/code-path-memory.md). Direct symbol/line is a strong, explainable signal;
// a regression sentinel is the strongest; a file-only match is weak; coupled scales with PPR coupling.
const BOOST_DIRECT_SYMBOL = 0.5;
const BOOST_SENTINEL_BONUS = 0.3; // → 0.8 for a regression sentinel
const BOOST_DIRECT_FILE = 0.25;
const DEFAULT_COUPLING_WEIGHT = 0.4; // coupled boost = couplingWeight × neighbour PPR score (≤ 0.4)

const strongestOutcome = (incs: Incident[]): IncidentOutcome | undefined => {
  let best: IncidentOutcome | undefined;
  let rank = 0;
  for (const i of incs) {
    const r = i.outcome ? OUTCOME_RANK[i.outcome] ?? 0 : 0;
    if (r > rank) {
      rank = r;
      best = i.outcome;
    }
  }
  return best;
};

/**
 * Intersect retrieved pitfalls' incident history with the diff's changed symbols + co-change
 * neighbours. Returns explainable alerts + a per-pitfall ranking boost.
 */
export function matchCodePath(
  retrieved: RetrievedPitfall[],
  graph: KnowledgeGraph,
  changed: CodeLocation[],
  neighbors: NeighborEntry[],
  opts: { maxIncidentsPerAlert?: number; couplingWeight?: number } = {},
): CodePathResult {
  const maxIds = opts.maxIncidentsPerAlert ?? 5;
  const couplingWeight = opts.couplingWeight ?? DEFAULT_COUPLING_WEIGHT;

  const changedFiles = new Set(changed.map((c) => c.file));
  const neighborScore = new Map<string, number>(); // coupled file → best PPR score (changed files excluded)
  for (const n of neighbors) {
    const f = String(n.node.props.path ?? '');
    if (f && !changedFiles.has(f)) neighborScore.set(f, Math.max(neighborScore.get(f) ?? 0, n.score));
  }

  const alerts: CodePathAlert[] = [];
  const boostByPitfall = new Map<string, number>();
  const seen = new Set<string>(); // (pitfall|kind|file|symbol) — one alert each
  const bump = (id: string, b: number): void => {
    boostByPitfall.set(id, Math.max(boostByPitfall.get(id) ?? 0, b));
  };

  for (const { pitfall } of retrieved) {
    if ((pitfall.polarity ?? 'positive') === 'negative') continue; // suppression owns its own (negative-knowledge) path
    const incs = historyOf(graph, pitfall.id); // both link directions, via the in-memory graph
    if (incs.length === 0) continue;

    // DIRECT — the symbols this diff actually touches.
    for (const c of changed) {
      const cKey = c.symbol ? symbolKey(c.file, c.symbol) : undefined;
      const symbolHits: Incident[] = [];
      const lineHits: Incident[] = [];
      const fileHits: Incident[] = [];
      for (const i of incs) {
        if (cKey && i.symbol && i.symbol === cKey) symbolHits.push(i);
        // Line-overlap is a fallback ONLY for an incident with no symbol key (e.g. mined). An incident
        // already keyed to a DIFFERENT symbol must not drift into this one just because its line falls
        // in range — that would mislabel the alert's `symbol`. (It only ever matches its own key above.)
        else if (c.symbol && !i.symbol && i.file === c.file && i.line != null && rangesOverlap(c.startLine, c.endLine, i.line, i.line)) lineHits.push(i);
        else if (!c.symbol && i.file === c.file) fileHits.push(i); // file-level change (no named symbol)
      }
      // Strongest matching rung wins; a file-only match never competes with a symbol/line one.
      const via: CodePathVia | undefined = symbolHits.length ? 'symbol-key' : lineHits.length ? 'line-overlap' : fileHits.length ? 'file' : undefined;
      if (!via) continue;
      const matched = via === 'symbol-key' ? symbolHits : via === 'line-overlap' ? lineHits : fileHits;
      const key = `${pitfall.id}|direct|${c.file}|${c.symbol ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const priorOutcome = strongestOutcome(matched);
      const sentinel = via !== 'file' && priorOutcome != null && SENTINEL_OUTCOMES.has(priorOutcome);
      const boost = via === 'file' ? BOOST_DIRECT_FILE : BOOST_DIRECT_SYMBOL + (sentinel ? BOOST_SENTINEL_BONUS : 0);
      alerts.push({
        pitfallId: pitfall.id, pitfallTitle: pitfall.title, kind: 'direct', file: c.file,
        symbol: via === 'file' ? undefined : c.symbol,
        priorOutcome, regressionSentinel: sentinel, via,
        incidentIds: matched.slice(0, maxIds).map((i) => i.id), boost,
      });
      bump(pitfall.id, boost);
    }

    // COUPLED — incidents in files that co-change with the change set (weaker, scaled by coupling).
    const coupledByFile = new Map<string, Incident[]>();
    for (const i of incs) {
      if (!i.file || !neighborScore.has(i.file)) continue;
      (coupledByFile.get(i.file) ?? coupledByFile.set(i.file, []).get(i.file)!).push(i);
    }
    for (const [file, list] of coupledByFile) {
      const key = `${pitfall.id}|coupled|${file}|`;
      if (seen.has(key)) continue;
      seen.add(key);
      const boost = couplingWeight * (neighborScore.get(file) ?? 0);
      if (boost <= 0) continue;
      alerts.push({
        pitfallId: pitfall.id, pitfallTitle: pitfall.title, kind: 'coupled', file,
        priorOutcome: strongestOutcome(list), regressionSentinel: false, via: 'coupled-file',
        incidentIds: list.slice(0, maxIds).map((i) => i.id), boost,
      });
      bump(pitfall.id, boost);
    }
  }

  // Sentinels and stronger boosts first — the order a reviewer should read them.
  alerts.sort((a, b) => Number(b.regressionSentinel) - Number(a.regressionSentinel) || b.boost - a.boost);
  return { alerts, boostByPitfall };
}

/** Fold the per-pitfall boost into retrieval scores (clamped) and re-rank. Pure. */
export function applyCodePathBoost(retrieved: RetrievedPitfall[], boostByPitfall: Map<string, number>): RetrievedPitfall[] {
  if (boostByPitfall.size === 0) return retrieved;
  return retrieved
    .map((r) => {
      const b = boostByPitfall.get(r.pitfall.id) ?? 0;
      return b > 0 ? { ...r, score: Math.min(0.99, r.score + b) } : r;
    })
    .sort((a, b) => b.score - a.score);
}
