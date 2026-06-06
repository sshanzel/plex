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
  /** Per-hop score decay. */
  hopDecay?: number;
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

/** Squash an unbounded co-change weight into (0,1): 0→0, 1→0.5, large→1. */
function squash(weight: number): number {
  return weight / (weight + 1);
}

/**
 * Materialize the review neighborhood (blast radius) for a diff (ADR-06).
 *
 * 1. Map changed hunks to the symbols they touch (line-range intersection).
 * 2. BFS out from changed files over CoChange + Imports edges, accumulating a
 *    coupling score that decays per hop. Co-change carries its learned weight;
 *    imports a fixed weight. A node reached by multiple sources/edges scores higher.
 */
export async function computeNeighborhood(
  db: CodeGraphDB,
  repo: string,
  diff: NormalizedDiff,
  opts: NeighborhoodOptions,
): Promise<ReviewNeighborhood> {
  const importWeight = opts.importWeight ?? 0.4;
  const refWeight = opts.refWeight ?? 0.5;
  const hopDecay = opts.hopDecay ?? 0.5;

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
  const score = new Map<string, number>();
  const via = new Map<string, Set<EdgeProvenance>>();
  const dist = new Map<string, number>();
  const seen = new Set(sources);
  let frontier = [...sources];

  for (let hop = 1; hop <= opts.maxHops && frontier.length > 0; hop++) {
    const decay = Math.pow(hopDecay, hop - 1);
    const [coEdges, impEdges, refEdges] = await Promise.all([
      getCoChangeEdges(db, frontier),
      getImportEdges(db, frontier),
      getRefEdges(db, frontier),
    ]);
    const next = new Set<string>();

    const bump = (dst: string, contrib: number, provenance: EdgeProvenance): void => {
      if (sources.has(dst)) return;
      score.set(dst, Math.min(1, (score.get(dst) ?? 0) + contrib));
      (via.get(dst) ?? via.set(dst, new Set()).get(dst)!).add(provenance);
      if (!dist.has(dst)) dist.set(dst, hop);
      if (!seen.has(dst)) next.add(dst);
    };

    for (const e of coEdges) bump(e.dst, squash(e.weight) * decay, 'co-change');
    for (const e of impEdges) bump(e.dst, importWeight * decay, 'import');
    for (const e of refEdges) bump(e.dst, refWeight * decay, 'precise-ref');

    for (const d of next) seen.add(d);
    frontier = [...next];
  }

  const neighbors: NeighborEntry[] = [...score.entries()]
    .filter(([, s]) => s >= opts.minScore)
    .sort((a, b) => b[1] - a[1])
    .slice(0, opts.maxNeighbors)
    .map(([id, s]) => ({
      node: { id, label: 'File' as const, props: { path: id } },
      score: s,
      via: [...(via.get(id) ?? [])],
      distance: dist.get(id) ?? 1,
    }));

  return { repo, changed, neighbors };
}
