import type { ReviewerConfig, EmbeddingProvider, Incident, CompletionProvider } from '@plex/core';
import { KnowledgeStore, addOrReinforcePitfall } from '@plex/knowledge';
import { listPrs, fetchCommentsForPr } from './github';
import { isSubstantive, categorize } from './classify';
import { greedyCluster, centroid, adaptiveCosineThreshold } from './cluster';
import { llmDistill, type ClusterInput } from './distill';
import { createCompletionProvider } from './llm';
import { outcomeFor } from './outcome';
import type { RawComment, DistillResult, LearnedLesson } from './types';

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
 * MECHANICAL half of analysis (no LLM): list new PRs, denoise, record provenance incidents,
 * embed, and cluster. Returns clusters for a distiller — either the standalone LLM distiller
 * (`distillHistory`) or the connected agent via MCP (rides the user's subscription).
 */
export async function scanHistory(
  store: KnowledgeStore,
  embed: EmbeddingProvider,
  config: ReviewerConfig,
  opts: DistillOptions,
): Promise<ScanResult> {
  const api = opts.fetch ?? { listPrs, fetchCommentsForPr };
  const skip = new Set(opts.alreadyScanned ?? []);
  const all = await api.listPrs({ cwd: opts.cwd, maxPrs: config.analyze.maxPrs, state: opts.state });
  // Order by PR number — oldest-first for chronological analysis, else newest-first (default).
  const ordered = [...all].sort((a, b) => (opts.order === 'oldest' ? a.number - b.number : b.number - a.number));
  const unscanned = ordered.filter((p) => !skip.has(p.number));
  const fresh = opts.limit != null ? unscanned.slice(0, opts.limit) : unscanned;

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
      // Code-path anchor (code-path memory): the comment's line. No `symbol` for mined incidents in
      // v1 — there's no code graph open at analyze time and a historical line may not map to a current
      // symbol; the review-time match uses line-overlap against the changed symbols' ranges instead.
      ...(c.line != null ? { line: c.line } : {}),
      snippet: c.body.slice(0, 300),
      outcome: outcomeFor(c),
      ts: c.createdAt ?? '',
    };
    await store.addIncident(inc);
    incidents++;
  }

  const vectors = await embed.embed(substantive.map((c) => c.body));
  // Adaptive cut from this batch's own cosine background (tuning.md §6) — the configured value is
  // the small-batch fallback, not a per-model magic constant.
  const threshold = adaptiveCosineThreshold(vectors, { fallback: config.analyze.clusterThreshold });
  const clusters = greedyCluster(vectors, threshold)
    // `minClusterSize` is an LLM-cost throttle, NOT a dedup mechanism (default 1 = no gate). Cross-run
    // de-duplication is now semantic, at write time (`addOrReinforcePitfall`), so a lone comment can
    // mint a low-confidence pitfall that later recurrences reinforce — raise this only to require
    // within-batch corroboration before spending an LLM call.
    .filter((idx) => idx.length >= config.analyze.minClusterSize)
    .map((idx) => ({
      comments: idx.map((i) => substantive[i]!),
      centroid: centroid(idx.map((i) => vectors[i]!)),
      repo: opts.repoName,
    }));

  return { clusters, scannedPrs, prsScanned: fresh.length, comments: raw.length, substantive: substantive.length, incidents };
}

export interface DistillOutcome {
  result: DistillResult;
  scannedPrs: number[];
}

/**
 * FULL standalone analysis: scan + distill each cluster with the configured LLM + store
 * pitfalls. Used by the CLI / cron. The MCP path uses `scanHistory` + agent distillation
 * instead (rides the subscription).
 */
export async function distillHistory(
  store: KnowledgeStore,
  embed: EmbeddingProvider,
  config: ReviewerConfig,
  opts: DistillOptions,
): Promise<DistillOutcome> {
  const scan = await scanHistory(store, embed, config, opts);
  const llm = opts.llm ?? createCompletionProvider(config.llm);
  if (!llm) {
    throw new Error(
      `Analysis requires an LLM distiller (ADR-20). Provider '${config.llm.provider}' is unavailable — ` +
        `the 'claude' CLI isn't installed or the API key is missing. Set PLEX_LLM_PROVIDER (claude-cli|anthropic|openai).`,
    );
  }

  let pitfalls = 0;
  let reinforced = 0;
  let skipped = 0;
  const learned: LearnedLesson[] = [];
  for (const cl of scan.clusters) {
    const pitfall = await llmDistill(cl, llm); // the LLM decides what's worth storing
    if (!pitfall) {
      skipped++;
      continue;
    }
    // Semantic match-or-reinforce (replaces exact-title dedup): a re-phrased recurrence of an
    // existing principle reinforces it instead of minting a near-duplicate (the 322-pitfall fix).
    const { action } = await addOrReinforcePitfall(store, pitfall);
    if (action === 'minted') pitfalls++;
    else reinforced++;
    // Capture the payoff: the lesson + how much of YOUR code it's anchored to (distinct comment paths).
    const files = new Set(cl.comments.map((c) => c.path).filter((p): p is string => !!p)).size;
    learned.push({ title: pitfall.title, scope: pitfall.scope === 'global' ? 'global' : 'repo', incidents: cl.comments.length, files, action });
  }

  return {
    result: {
      prsScanned: scan.prsScanned,
      comments: scan.comments,
      substantive: scan.substantive,
      clusters: scan.clusters.length,
      pitfalls,
      reinforced,
      skipped,
      incidents: scan.incidents,
      distiller: llm.name,
      learned,
    },
    scannedPrs: scan.scannedPrs,
  };
}

export { categorize };
