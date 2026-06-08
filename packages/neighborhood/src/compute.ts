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

  const sources = new Set(changedFileIds);
  const ppr = new Map<string, number>(); // accumulated PageRank mass (the deposited score)
  const via = new Map<string, Set<EdgeProvenance>>();
  const dist = new Map<string, number>();
  // Residual mass still to propagate — the teleport vector starts split evenly across the seeds.
  let residual = new Map<string, number>(changedFileIds.map((id) => [id, 1 / Math.max(1, sources.size)]));

  // Forward-push personalized PageRank, batched by hop (one set of edge queries per iteration).
  // At each step a node deposits `restart·residual` (mass that stays put) and forwards the rest
  // split across its out-edges in proportion to edge weight — so a high-degree hub dilutes natively.
  for (let hop = 1; hop <= opts.maxHops && residual.size > 0; hop++) {
    const frontier = [...residual.keys()];
    const [coEdges, impEdges, refEdges] = await Promise.all([
      getCoChangeEdges(db, frontier),
      getImportEdges(db, frontier),
      getRefEdges(db, frontier),
    ]);
    // Co-change degrees for BOTH endpoints — normalizes pair strength by promiscuity (assoc. strength).
    const coDeg = await getCoChangeDegrees(db, [...new Set(coEdges.flatMap((e) => [e.src, e.dst]))]);

    // Weighted out-edges per frontier file (co-change = association strength; import/ref = base weight).
    const out = new Map<string, { dst: string; w: number; prov: EdgeProvenance }[]>();
    const addEdge = (src: string, dst: string, w: number, prov: EdgeProvenance): void => {
      if (w <= 0) return;
      (out.get(src) ?? out.set(src, []).get(src)!).push({ dst, w, prov });
    };
    for (const e of coEdges) addEdge(e.src, e.dst, associationStrength(e.weight, coDeg.get(e.src) ?? e.weight, coDeg.get(e.dst) ?? e.weight), 'co-change');
    for (const e of impEdges) addEdge(e.src, e.dst, importWeight, 'import');
    for (const e of refEdges) addEdge(e.src, e.dst, refWeight, 'precise-ref');

    const nextResidual = new Map<string, number>();
    for (const u of frontier) {
      const ru = residual.get(u) ?? 0;
      if (ru <= 0) continue;
      ppr.set(u, (ppr.get(u) ?? 0) + restart * ru); // deposit the restart share at u
      const edges = out.get(u) ?? [];
      const deg = edges.reduce((s, e) => s + e.w, 0);
      if (deg <= 0) continue;
      const flow = (1 - restart) * ru;
      for (const e of edges) {
        nextResidual.set(e.dst, (nextResidual.get(e.dst) ?? 0) + flow * (e.w / deg));
        (via.get(e.dst) ?? via.set(e.dst, new Set()).get(e.dst)!).add(e.prov);
        if (!dist.has(e.dst) && !sources.has(e.dst)) dist.set(e.dst, hop);
      }
    }
    residual = nextResidual;
  }
  // Deposit whatever mass is still in flight after the last hop (so reachable nodes aren't lost).
  for (const [u, ru] of residual) ppr.set(u, (ppr.get(u) ?? 0) + restart * ru);

  // Neighbors = PPR mass on NON-seed nodes, normalized so the top neighbor scores 1 — PPR mass is
  // otherwise tiny/absolute-scale-dependent, and this preserves the [0,1] / minScore semantics.
  const ranked = [...ppr.entries()].filter(([id, s]) => !sources.has(id) && s > 0);
  const max = ranked.reduce((m, [, s]) => Math.max(m, s), 0);
  const neighbors: NeighborEntry[] = ranked
    .map(([id, s]) => [id, max > 0 ? s / max : 0] as [string, number])
    .filter(([, s]) => s >= opts.minScore)
    // Sort by score, then by id — a stable secondary key makes the maxNeighbors cutoff deterministic.
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, opts.maxNeighbors)
    .map(([id, s]) => ({
      node: { id, label: 'File' as const, props: { path: id } },
      score: s,
      via: [...(via.get(id) ?? [])],
      distance: dist.get(id) ?? 1,
    }));

  return { repo, changed, neighbors };
}
