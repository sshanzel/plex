/**
 * Parallel-review guardrail (design: docs/design/parallel-review.md) — PURE, zero-LLM.
 * Decides whether a review should fan out into subagents, and into which units, from the
 * coupling graph alone. Fanning out a small or tightly-coupled change is *worse* (N× tokens
 * for a slower, dumber review), so the default is `single` unless fan-out clearly wins.
 */

export interface ReviewUnit {
  files: string[];
}

export interface ReviewPlan {
  strategy: 'single' | 'parallel';
  /** One unit (all files) for `single`; one per cluster for `parallel`. */
  units: ReviewUnit[];
  /** Human-readable why — surfaced so the decision is auditable. */
  reason: string;
}

export interface ReviewPlanOptions {
  /** Review surface: changed symbols + blast-radius nodes (or changed LOC). */
  surface: number;
  /** Below this many changed files → single (one reviewer is faster). Default 6. */
  minFiles?: number;
  /** Below this surface → single (too small to be worth splitting). Default 150. */
  minSurface?: number;
  /** Cap on parallel reviewers; smallest clusters merge to stay under it. Default 5. */
  maxAgents?: number;
  /** Clusters smaller than this are "tiny" and folded in, never given their own agent. Default 2. */
  minClusterFiles?: number;
}

/**
 * Partition `files` into connected components under the undirected `coupled` edges (union-find).
 * Edges to files outside `files` are ignored; an uncoupled file is its own singleton cluster.
 */
export function partitionByCoupling(files: string[], coupled: ReadonlyArray<readonly [string, string]>): string[][] {
  const parent = new Map<string, string>(files.map((f) => [f, f]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  for (const [a, b] of coupled) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const r = find(f);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(f);
  }
  return [...groups.values()];
}

/**
 * THE GUARDRAIL: single-agent vs parallel fan-out, decided from coupling + surface alone.
 * Conservative — returns `single` unless the change splits into ≥2 significant clusters AND
 * is big enough to be worth the N× cost.
 */
export function reviewPlan(
  files: string[],
  coupled: ReadonlyArray<readonly [string, string]>,
  opts: ReviewPlanOptions,
): ReviewPlan {
  const minFiles = opts.minFiles ?? 6;
  const minSurface = opts.minSurface ?? 150;
  const maxAgents = opts.maxAgents ?? 5;
  const minClusterFiles = opts.minClusterFiles ?? 2;
  const single = (reason: string): ReviewPlan => ({ strategy: 'single', units: [{ files: [...files] }], reason });

  if (files.length < minFiles) return single(`only ${files.length} changed file(s) (< ${minFiles}) — one reviewer is faster`);
  if (opts.surface < minSurface) return single(`review surface ${opts.surface} (< ${minSurface}) — too small to parallelize`);

  const clusters = partitionByCoupling(files, coupled);
  const significant = clusters.filter((c) => c.length >= minClusterFiles).sort((a, b) => b.length - a.length);
  if (significant.length < 2) {
    return single(`changes form one coupled cluster — fan-out would sever the cross-file reasoning`);
  }

  // Fold tiny clusters into the smallest significant unit (never spawn an agent for ~1 file).
  let units = significant.map((c) => [...c]);
  const tiny = clusters.filter((c) => c.length < minClusterFiles).flatMap((c) => c);
  if (tiny.length) units[units.length - 1]!.push(...tiny);

  // Cap to maxAgents: repeatedly merge the two smallest units.
  units.sort((a, b) => b.length - a.length);
  while (units.length > maxAgents) {
    const b = units.pop()!;
    const a = units.pop()!;
    units.push([...a, ...b]);
    units.sort((x, y) => y.length - x.length);
  }
  if (units.length < 2) return single(`after merging, only one review unit remains`);

  return {
    strategy: 'parallel',
    units: units.map((f) => ({ files: f })),
    reason: `${units.length} weakly-coupled clusters across ${files.length} files (surface ${opts.surface}) — fan out ${units.length} reviewers`,
  };
}
