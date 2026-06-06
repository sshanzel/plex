import type { ReviewerConfig, EmbeddingProvider, Incident, CompletionProvider } from '@plex/core';
import { KnowledgeStore } from '@plex/knowledge';
import { listPrs, fetchCommentsForPr } from './github';
import { isSubstantive, categorize } from './classify';
import { greedyCluster, centroid } from './cluster';
import { llmDistill, type ClusterInput } from './distill';
import { createCompletionProvider } from './llm';
import { outcomeFor } from './outcome';
import type { RawComment, MineResult } from './types';

export interface MineOptions {
  cwd: string;
  repoName?: string;
  /** PR numbers already scanned in a previous run — skipped to make mining incremental. */
  alreadyScanned?: number[];
  state?: 'merged' | 'all';
  /** Injectable GitHub layer (defaults to the real `gh` CLI) — lets tests run offline. */
  fetch?: {
    listPrs: typeof listPrs;
    fetchCommentsForPr: typeof fetchCommentsForPr;
  };
  /** Inject the LLM distiller (defaults to the configured provider) — for tests. */
  llm?: CompletionProvider;
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
 * MECHANICAL half of mining (no LLM): list new PRs, denoise, record provenance incidents,
 * embed, and cluster. Returns clusters for a distiller — either the heuristic/API distiller
 * (`mineHistory`) or the connected agent via MCP (rides the user's subscription).
 */
export async function scanHistory(
  store: KnowledgeStore,
  embed: EmbeddingProvider,
  config: ReviewerConfig,
  opts: MineOptions,
): Promise<ScanResult> {
  const api = opts.fetch ?? { listPrs, fetchCommentsForPr };
  const skip = new Set(opts.alreadyScanned ?? []);
  const prs = await api.listPrs({ cwd: opts.cwd, maxPrs: config.mining.maxPrs, state: opts.state });
  const fresh = prs.filter((p) => !skip.has(p.number));

  const raw: RawComment[] = [];
  for (const pr of fresh) raw.push(...(await api.fetchCommentsForPr(opts.cwd, pr)));
  const scannedPrs = [...new Set([...skip, ...fresh.map((p) => p.number)])].sort((a, b) => a - b);

  const substantive = raw.filter((c) => isSubstantive(c.body));
  if (substantive.length === 0) {
    return { clusters: [], scannedPrs, prsScanned: fresh.length, comments: raw.length, substantive: 0, incidents: 0 };
  }

  // Provenance incidents (dedup by id so re-runs don't duplicate).
  const existing = new Set((await store.incidents()).map((i) => i.id));
  let incidents = 0;
  for (const c of substantive) {
    const id = `inc:mined:${c.id}`;
    if (existing.has(id)) continue;
    const inc: Incident = {
      id,
      source: 'mined',
      repo: opts.repoName,
      file: c.path,
      snippet: c.body.slice(0, 300),
      outcome: outcomeFor(c),
      ts: c.createdAt ?? '',
    };
    await store.addIncident(inc);
    incidents++;
  }

  const vectors = await embed.embed(substantive.map((c) => c.body));
  const clusters = greedyCluster(vectors, config.mining.clusterThreshold)
    .filter((idx) => idx.length >= config.mining.minClusterSize)
    .map((idx) => ({
      comments: idx.map((i) => substantive[i]!),
      centroid: centroid(idx.map((i) => vectors[i]!)),
      repo: opts.repoName,
    }));

  return { clusters, scannedPrs, prsScanned: fresh.length, comments: raw.length, substantive: substantive.length, incidents };
}

export interface MineOutcome {
  result: MineResult;
  scannedPrs: number[];
}

/**
 * FULL standalone mining: scan + distill each cluster (heuristic, or the configured LLM
 * if a key is set) + store pitfalls. Used by the CLI / cron. The MCP path uses
 * `scanHistory` + agent distillation instead (rides the subscription).
 */
export async function mineHistory(
  store: KnowledgeStore,
  embed: EmbeddingProvider,
  config: ReviewerConfig,
  opts: MineOptions,
): Promise<MineOutcome> {
  const scan = await scanHistory(store, embed, config, opts);
  const llm = opts.llm ?? createCompletionProvider(config.llm);
  if (!llm) {
    throw new Error(
      `Mining requires an LLM distiller (ADR-20). Provider '${config.llm.provider}' is unavailable — ` +
        `the 'claude' CLI isn't installed or the API key is missing. Set PLEX_LLM_PROVIDER (claude-cli|anthropic|openai).`,
    );
  }

  let pitfalls = 0;
  let skipped = 0;
  for (const cl of scan.clusters) {
    const pitfall = await llmDistill(cl, llm); // the LLM decides what's worth storing
    if (!pitfall) {
      skipped++;
      continue;
    }
    if (await store.hasPitfallTitled(pitfall.title)) continue;
    await store.addPitfall(pitfall);
    pitfalls++;
  }

  return {
    result: {
      prsScanned: scan.prsScanned,
      comments: scan.comments,
      substantive: scan.substantive,
      clusters: scan.clusters.length,
      pitfalls,
      skipped,
      incidents: scan.incidents,
      distiller: llm.name,
    },
    scannedPrs: scan.scannedPrs,
  };
}

export { categorize };
