import type { ReviewerConfig, EmbeddingProvider, Incident } from '@plex/core';
import { KnowledgeStore } from '@plex/knowledge';
import { listPrs, fetchCommentsForPr } from './github';
import { isSubstantive, categorize } from './classify';
import { greedyCluster, centroid, adaptiveCosineThreshold } from './cluster';
import type { ClusterInput } from './distill';
import { outcomeFor } from './outcome';
import type { RawComment } from './types';

export interface DistillOptions {
  cwd: string;
  repoName?: string;
  /** PR numbers already scanned in a previous run — skipped to make analysis incremental. */
  alreadyScanned?: number[];
  state?: 'merged' | 'all';
  /** PR order to scan: `oldest` (chronological, lowest number first) or `newest` (default). */
  order?: 'newest' | 'oldest';
  /** Max number of fresh (unscanned) PRs to scan THIS run; the cursor advances so the next
   *  run continues from where this left off. Unset = scan all fresh PRs. */
  limit?: number;
  /** Injectable GitHub layer (defaults to the real `gh` CLI) — lets tests run offline. */
  fetch?: {
    listPrs: typeof listPrs;
    fetchCommentsForPr: typeof fetchCommentsForPr;
  };
}

export interface ScanResult {
  /** Clusters of similar substantive comments ready to distill (size ≥ minClusterSize). */
  clusters: ClusterInput[];
  /** Cumulative scanned PR numbers (persist for the next incremental run). */
  scannedPrs: number[];
  prsScanned: number;
  comments: number;
  substantive: number;
  incidents: number;
}

/**
 * MECHANICAL half of analysis (no LLM): list new PRs, denoise, record provenance incidents, embed,
 * and cluster. Returns clusters for the connected agent to distill (the MCP `analyze_scan` path).
 */
export async function scanHistory(
  store: KnowledgeStore,
  embed: EmbeddingProvider,
  config: ReviewerConfig,
  opts: DistillOptions,
): Promise<ScanResult> {
  const api = opts.fetch ?? { listPrs, fetchCommentsForPr };
  const skip = new Set(opts.alreadyScanned ?? []);
  // `oldest` must reach the chronological start, so widen the fetch window past the default cap (this
  // lived in the old `plex analyze` CLI handler; it moves here so the MCP `analyze_scan` path keeps it,
  // ADR-51). Otherwise "oldest" only sorts the most-recent `maxPrs` PRs and never reaches PR #1.
  const maxPrs = opts.order === 'oldest' ? Math.max(config.analyze.maxPrs, 1000) : config.analyze.maxPrs;
  const all = await api.listPrs({ cwd: opts.cwd, maxPrs, state: opts.state });
  const ordered = [...all].sort((a, b) => (opts.order === 'oldest' ? a.number - b.number : b.number - a.number));
  const unscanned = ordered.filter((p) => !skip.has(p.number));
  // Per-run cost guard (ADR-51): with no explicit `--limit`, cap fresh PRs at `maxPrsPerRun` so a
  // bare `/plex:analyze` can't distill an unbounded run; an explicit `--limit` is the user's override.
  const limit = opts.limit ?? config.analyze.maxPrsPerRun;
  const fresh = unscanned.slice(0, limit);

  const raw: RawComment[] = [];
  for (const pr of fresh) raw.push(...(await api.fetchCommentsForPr(opts.cwd, pr)));
  const scannedPrs = [...new Set([...skip, ...fresh.map((p) => p.number)])].sort((a, b) => a - b);

  const substantive = raw.filter((c) => isSubstantive(c.body));
  if (substantive.length === 0) {
    return { clusters: [], scannedPrs, prsScanned: fresh.length, comments: raw.length, substantive: 0, incidents: 0 };
  }

  const existing = new Set((await store.incidents()).map((i) => i.id));
  let incidents = 0;
  for (const c of substantive) {
    const id = `inc:analyzed:${c.id}`;
    if (existing.has(id)) continue;
    const inc: Incident = {
      id,
      source: 'analyzed',
      repo: opts.repoName,
      file: c.path,
      // Code-path anchor: the comment's line. No `symbol` for mined incidents — no code graph at analyze
      // time; the review-time match uses line-overlap against the changed symbols' ranges instead.
      ...(c.line != null ? { line: c.line } : {}),
      snippet: c.body.slice(0, 300),
      outcome: outcomeFor(c),
      ts: c.createdAt ?? '',
    };
    await store.addIncident(inc);
    incidents++;
  }

  const vectors = await embed.embed(substantive.map((c) => c.body));
  // Adaptive cut from this batch's own cosine background (tuning.md §6); the configured value is the small-batch fallback.
  const threshold = adaptiveCosineThreshold(vectors, { fallback: config.analyze.clusterThreshold });
  const clusters = greedyCluster(vectors, threshold)
    // `minClusterSize` is an LLM-cost throttle, NOT a dedup mechanism (default 1 = no gate; dedup is
    // semantic at write time via `addOrReinforcePitfall`).
    .filter((idx) => idx.length >= config.analyze.minClusterSize)
    .map((idx) => ({
      comments: idx.map((i) => substantive[i]!),
      centroid: centroid(idx.map((i) => vectors[i]!)),
      repo: opts.repoName,
    }));

  return { clusters, scannedPrs, prsScanned: fresh.length, comments: raw.length, substantive: substantive.length, incidents };
}

export { categorize };
