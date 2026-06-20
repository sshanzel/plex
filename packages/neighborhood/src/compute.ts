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
  getBarrelFiles,
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
  /** PPR restart/teleport probability (tuning.md §2); higher = more local. Default 0.15 (damping d = 1 − restart = 0.85). */
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
 * Association strength (Salton cosine) of a co-change pair: `co / √(degA·degB)` ∈ (0,1]. Pure. Divides
 * out co-change PROMISCUITY (a file that co-changes with everything collapses toward 0). The `max(co,deg)`
 * floor keeps a stale degree below the pair weight from pushing the result above 1 (tuning.md §4).
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
 * seeded on `seeds`. `expand(frontier)` supplies the frontier's weighted out-edges — injected so this
 * propagation is PURE (db queries + edge weighting live in the caller). Each node deposits `restart·residual`
 * and forwards the rest split across out-edges by weight (a hub dilutes natively). Seeds excluded; scores
 * max-normalized to [0,1], minScore-filtered, ranked, capped at maxNeighbors.
 *
 * `transparent` nodes (barrels — `getBarrelFiles`) are pass-through: deposit NO mass (local restart = 0),
 * forward ALL residual, dropped from output AND from the normalizing max (else the barrel sets the ceiling
 * and buries its consumers). A seed is NEVER transparent (the changed file is the signal).
 */
export async function personalizedPageRank(
  seeds: readonly string[],
  expand: (frontier: string[]) => Promise<readonly WeightedEdge[]>,
  opts: { restart: number; maxHops: number; maxNeighbors: number; minScore: number; transparent?: ReadonlySet<string> },
): Promise<PprNeighbor[]> {
  const sources = new Set(seeds);
  // A barrel is transparent ONLY if it isn't itself a seed file.
  const isTransparent = (id: string): boolean => (opts.transparent?.has(id) ?? false) && !sources.has(id);
  const ppr = new Map<string, number>();
  const via = new Map<string, Set<EdgeProvenance>>();
  const dist = new Map<string, number>();
  // Teleport vector starts split evenly across the seeds.
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
      // Transparent (barrel) nodes deposit nothing and forward 100%.
      const restart = isTransparent(u) ? 0 : opts.restart;
      ppr.set(u, (ppr.get(u) ?? 0) + restart * ru);
      const ue = out.get(u) ?? [];
      const deg = ue.reduce((s, e) => s + e.w, 0);
      if (deg <= 0) continue;
      const flow = (1 - restart) * ru;
      for (const e of ue) {
        nextResidual.set(e.dst, (nextResidual.get(e.dst) ?? 0) + flow * (e.w / deg));
        (via.get(e.dst) ?? via.set(e.dst, new Set()).get(e.dst)!).add(e.via);
        if (!dist.has(e.dst) && !sources.has(e.dst)) dist.set(e.dst, hop);
      }
    }
    residual = nextResidual;
  }
  // Deposit in-flight mass after the last hop so reachable nodes aren't lost (transparent nodes still deposit nothing).
  for (const [u, ru] of residual) ppr.set(u, (ppr.get(u) ?? 0) + (isTransparent(u) ? 0 : opts.restart) * ru);

  // Exclude transparent nodes from output AND the normalizing max (else a barrel sets the ceiling).
  const ranked = [...ppr.entries()].filter(([id, s]) => !sources.has(id) && !isTransparent(id) && s > 0);
  const max = ranked.reduce((m, [, s]) => Math.max(m, s), 0);
  return ranked
    .map(([id, s]) => ({ id, score: max > 0 ? s / max : 0, via: [...(via.get(id) ?? [])], distance: dist.get(id) ?? 1 }))
    .filter((r) => r.score >= opts.minScore)
    // id as a stable secondary key → deterministic maxNeighbors cutoff.
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, opts.maxNeighbors);
}

/**
 * Materialize the review neighborhood (blast radius) for a diff (ADR-06, tuning.md §2): (1) map changed
 * hunks to touched symbols, (2) score every other file by personalized PageRank seeded on the changed
 * files over CoChange ∪ Imports ∪ Refs (co-change = association strength; import/ref = fixed base weight).
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
    const id = f.path;
    if (!(await fileExists(db, id))) continue;
    changedFileIds.push(id);

    // A DELETED file is blast signal, not silence: keep its (pre-deletion) node as a PPR seed so the
    // walk pulls its now-broken dependents into the radius. Only a file-level marker to record.
    if (f.status === 'deleted') {
      changed.push({ repo, file: id, startLine: 1, endLine: 1 });
      continue;
    }

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

  // Supply each frontier's weighted out-edges — the impure half; the propagation is pure `personalizedPageRank`.
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

  // Barrel / re-export files are transparent in the walk (ADR-06 refinement). Computed once here.
  const transparent = await getBarrelFiles(db);

  const ranked = await personalizedPageRank(changedFileIds, expand, {
    restart,
    maxHops: opts.maxHops,
    maxNeighbors: opts.maxNeighbors,
    minScore: opts.minScore,
    transparent,
  });
  const neighbors: NeighborEntry[] = ranked.map((r) => ({
    node: { id: r.id, label: 'File' as const, props: { path: r.id } },
    score: r.score,
    via: r.via,
    distance: r.distance,
  }));

  return { repo, changed, neighbors };
}
