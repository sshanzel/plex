import type {
  NormalizedDiff,
  ReviewNeighborhood,
  CodeLocation,
  NeighborEntry,
  EdgeProvenance,
} from '@plex/core';
import {
  CodeGraphDB,
  getSymbolsInFile,
  getCoChangeEdges,
  getCoChangeDegrees,
  getImportEdges,
  getRefEdges,
  fileExists,
  type SymbolRow,
} from '@plex/code-graph';

export interface NeighborhoodOptions {
  maxHops: number;
  maxNeighbors: number;
  minScore: number;
  /** Fixed contribution of an import edge (co-change uses its learned weight). */
  importWeight?: number;
  /** Fixed contribution of a precise (alias-aware) reference edge. */
  refWeight?: number;
  /**
   * Random-walk restart/teleport probability for the personalized-PageRank propagation (tuning.md §2).
   * Higher = more local (probability mass stays near the changed files). Default 0.15 (the RWR/PPR
   * convention; damping d = 1 − restart = 0.85).
   */
  restart?: number;
}

/** Inclusive 1-based range overlap. Pure. */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** Symbols whose span overlaps any changed range. Pure (unit-tested without I/O). */
export function symbolsTouchedByRanges(
  symbols: SymbolRow[],
  ranges: { start: number; end: number }[],
): SymbolRow[] {
  return symbols.filter((s) =>
    ranges.some((r) => rangesOverlap(s.startLine, s.endLine, r.start, r.end)),
  );
}

/**
 * Association strength (Salton cosine) of a co-change pair: `co / sqrt(degA · degB)` ∈ (0,1].
 * Divides out each file's co-change PROMISCUITY — a config/lockfile/barrel that co-changes with
 * *everything* has a huge degree, so its pair strengths collapse toward 0; an exclusively-coupled
 * pair (each only co-changes with the other) scores 1. This is the read-time, no-storage form of
 * lift's frequency-confound removal (tuning.md §4; van Eck & Waltman 2009 on co-occurrence
 * normalization). Pure. `degA`/`degB` are each ≥ `co`, so the result never exceeds 1.
 */
export function associationStrength(co: number, degA: number, degB: number): number {
  const denom = Math.sqrt(Math.max(co, degA) * Math.max(co, degB));
  return denom > 0 ? Math.min(1, co / denom) : 0;
}

/** A weighted, provenance-tagged directed edge for the PPR walk. */
export interface WeightedEdge {
  src: string;
  dst: string;
  w: number;
  via: EdgeProvenance;
}

/** A scored PPR neighbor (normalized so the top neighbor = 1). */
export interface PprNeighbor {
  id: string;
  score: number;
  via: EdgeProvenance[];
  distance: number;
}

/**
 * Forward-push **personalized PageRank** (random-walk-with-restart) over a weighted directed graph,
 * seeded on `seeds`. `expand(frontier)` supplies the weighted out-edges of the current frontier —
 * injected so this propagation is PURE (the db queries + edge weighting live in the caller; tests
 * pass a plain adjacency). Each node deposits `restart·residual` (mass that stays) and forwards the
 * rest split across its out-edges in proportion to weight — so a high-degree hub dilutes natively,
 * a node reached by several paths accumulates more, and scores converge. Seeds are excluded; scores
 * are max-normalized to [0,1]; the result is minScore-filtered, ranked, and capped at maxNeighbors.
 */
export async function personalizedPageRank(
  seeds: readonly string[],
  expand: (frontier: string[]) => Promise<readonly WeightedEdge[]>,
  opts: { restart: number; maxHops: number; maxNeighbors: number; minScore: number },
): Promise<PprNeighbor[]> {
  const sources = new Set(seeds);
  const ppr = new Map<string, number>(); // accumulated PageRank mass (the deposited score)
  const via = new Map<string, Set<EdgeProvenance>>();
  const dist = new Map<string, number>();
  // Residual mass still to propagate — the teleport vector starts split evenly across the seeds.
  let residual = new Map<string, number>([...sources].map((id) => [id, 1 / Math.max(1, sources.size)]));

  for (let hop = 1; hop <= opts.maxHops && residual.size > 0; hop++) {
    const frontier = [...residual.keys()];
    const out = new Map<string, WeightedEdge[]>();
    for (const e of await expand(frontier)) {
      if (e.w <= 0) continue;
      (out.get(e.src) ?? out.set(e.src, []).get(e.src)!).push(e);
    }
    const nextResidual = new Map<string, number>();
    for (const u of frontier) {
      const ru = residual.get(u) ?? 0;
      if (ru <= 0) continue;
      ppr.set(u, (ppr.get(u) ?? 0) + opts.restart * ru); // deposit the restart share at u
      const ue = out.get(u) ?? [];
      const deg = ue.reduce((s, e) => s + e.w, 0);
      if (deg <= 0) continue;
      const flow = (1 - opts.restart) * ru;
      for (const e of ue) {
        nextResidual.set(e.dst, (nextResidual.get(e.dst) ?? 0) + flow * (e.w / deg));
        (via.get(e.dst) ?? via.set(e.dst, new Set()).get(e.dst)!).add(e.via);
        if (!dist.has(e.dst) && !sources.has(e.dst)) dist.set(e.dst, hop);
      }
    }
    residual = nextResidual;
  }
  // Deposit whatever mass is still in flight after the last hop (so reachable nodes aren't lost).
  for (const [u, ru] of residual) ppr.set(u, (ppr.get(u) ?? 0) + opts.restart * ru);

  const ranked = [...ppr.entries()].filter(([id, s]) => !sources.has(id) && s > 0);
  const max = ranked.reduce((m, [, s]) => Math.max(m, s), 0);
  return ranked
    .map(([id, s]) => ({ id, score: max > 0 ? s / max : 0, via: [...(via.get(id) ?? [])], distance: dist.get(id) ?? 1 }))
    .filter((r) => r.score >= opts.minScore)
    // Sort by score, then by id — a stable secondary key makes the maxNeighbors cutoff deterministic.
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, opts.maxNeighbors);
}

/**
 * Materialize the review neighborhood (blast radius) for a diff (ADR-06, tuning.md §2).
 *
 * 1. Map changed hunks to the symbols they touch (line-range intersection).
 * 2. Score every other file by **personalized PageRank** (random-walk-with-restart) seeded on the
 *    changed files, walking CoChange ∪ Imports ∪ Refs edges. The walk's transition is degree-
 *    normalized — a node passes its mass split across its out-edges by weight — so a hub
 *    (barrel/registry imported by hundreds) natively dilutes what it forwards, with no separate
 *    hub-damping. Co-change edges carry their association strength; import/ref a fixed base weight.
 *    Scores are normalized so the top neighbor = 1 (a node reached by many short paths ranks high).
 */
export async function computeNeighborhood(
  db: CodeGraphDB,
  repo: string,
  diff: NormalizedDiff,
  opts: NeighborhoodOptions,
): Promise<ReviewNeighborhood> {
  const importWeight = opts.importWeight ?? 0.4;
  const refWeight = opts.refWeight ?? 0.5;
  const restart = opts.restart ?? 0.15;

  const changed: CodeLocation[] = [];
  const changedFileIds: string[] = [];

  for (const f of diff.files) {
    if (f.status === 'deleted') continue;
    const id = f.path;
    if (!(await fileExists(db, id))) continue;
    changedFileIds.push(id);

    const ranges = f.hunks.flatMap((h) => h.newRanges);
    const touched = symbolsTouchedByRanges(await getSymbolsInFile(db, id), ranges);
    if (touched.length > 0) {
      for (const s of touched) {
        changed.push({ repo, file: id, startLine: s.startLine, endLine: s.endLine, symbol: s.name });
      }
    } else {
      const starts = ranges.map((r) => r.start);
      const ends = ranges.map((r) => r.end);
      changed.push({
        repo,
        file: id,
        startLine: starts.length ? Math.min(...starts) : 1,
        endLine: ends.length ? Math.max(...ends) : 1,
      });
    }
  }

  // Lazily supply each frontier's weighted out-edges (co-change = association strength; import/ref =
  // base weight) — the impure half; the PPR propagation itself is the pure `personalizedPageRank`.
  const expand = async (frontier: string[]): Promise<WeightedEdge[]> => {
    const [coEdges, impEdges, refEdges] = await Promise.all([
      getCoChangeEdges(db, frontier),
      getImportEdges(db, frontier),
      getRefEdges(db, frontier),
    ]);
    const coDeg = await getCoChangeDegrees(db, [...new Set(coEdges.flatMap((e) => [e.src, e.dst]))]);
    const edges: WeightedEdge[] = [];
    for (const e of coEdges) edges.push({ src: e.src, dst: e.dst, w: associationStrength(e.weight, coDeg.get(e.src) ?? e.weight, coDeg.get(e.dst) ?? e.weight), via: 'co-change' });
    for (const e of impEdges) edges.push({ src: e.src, dst: e.dst, w: importWeight, via: 'import' });
    for (const e of refEdges) edges.push({ src: e.src, dst: e.dst, w: refWeight, via: 'precise-ref' });
    return edges;
  };

  const ranked = await personalizedPageRank(changedFileIds, expand, {
    restart,
    maxHops: opts.maxHops,
    maxNeighbors: opts.maxNeighbors,
    minScore: opts.minScore,
  });
  const neighbors: NeighborEntry[] = ranked.map((r) => ({
    node: { id: r.id, label: 'File' as const, props: { path: r.id } },
    score: r.score,
    via: r.via,
    distance: r.distance,
  }));

  return { repo, changed, neighbors };
}
