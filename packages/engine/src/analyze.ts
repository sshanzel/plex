import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ReviewerConfig, Pitfall, PitfallTier } from '@plex/core';
import { distillHistory, scanHistory, categorize, distilledPitfallId, type DistillResult } from '@plex/distill';
import { confidenceFromOutcomes, addOrReinforcePitfall } from '@plex/knowledge';
import { knowledgeStore, requireEmbeddings } from './knowledge';
import { repoPaths } from './paths';

// The product feature is "analyze your PR review history"; the technique it uses (cluster +
// LLM-distill) lives in @plex/distill. Cursor state is `analyze-state.json`; incident provenance
// is `inc:analyzed:`.

/** Per-repo incremental scan cursor (ADR-11): which PRs have been scanned. */
export interface AnalyzeState {
  repo: string;
  scannedPrs: number[];
  lastRun: string;
}

export async function loadAnalyzeState(
  repoPath: string,
  config: ReviewerConfig,
): Promise<AnalyzeState> {
  const p = repoPaths(repoPath, config.dataDir);
  try {
    return JSON.parse(await fs.readFile(p.analyzeStateFile, 'utf8')) as AnalyzeState;
  } catch {
    return { repo: path.basename(p.repoPath), scannedPrs: [], lastRun: '' };
  }
}

async function saveAnalyzeState(repoPath: string, config: ReviewerConfig, state: AnalyzeState): Promise<void> {
  const p = repoPaths(repoPath, config.dataDir);
  await fs.mkdir(path.dirname(p.analyzeStateFile), { recursive: true });
  await fs.writeFile(p.analyzeStateFile, JSON.stringify(state, null, 2), 'utf8');
}

export interface AnalyzeOptions {
  /** Re-scan from scratch, ignoring the saved cursor. */
  reset?: boolean;
  state?: 'merged' | 'all';
  /** `oldest` = chronological (PR #1 up); default newest-first. */
  order?: 'newest' | 'oldest';
  /** Max fresh PRs to scan this run (the cursor advances for the next run). */
  limit?: number;
}

/**
 * Analyze a repo's PR review history into the knowledge base, incrementally — only PRs not
 * in the saved cursor are pulled, and the cursor is updated afterward (ADR-11).
 */
export async function analyzeRepo(
  repoPath: string,
  config: ReviewerConfig,
  opts: AnalyzeOptions = {},
): Promise<DistillResult & { totalScanned: number }> {
  const p = repoPaths(repoPath, config.dataDir);
  const repo = path.basename(p.repoPath);
  const prior = opts.reset ? { repo, scannedPrs: [], lastRun: '' } : await loadAnalyzeState(repoPath, config);

  const embed = requireEmbeddings(config);
  const store = knowledgeStore(config);
  const { result, scannedPrs } = await distillHistory(store, embed, config, {
    cwd: p.repoPath,
    repoName: repo,
    alreadyScanned: prior.scannedPrs,
    state: opts.state,
    order: opts.order,
    limit: opts.limit,
  });

  await saveAnalyzeState(repoPath, config, { repo, scannedPrs, lastRun: new Date().toISOString() });
  return { ...result, totalScanned: scannedPrs.length };
}

// ---------------------------------------------------------------------------
// Agent-driven analysis (rides the connected agent's subscription — no API key).
// analyze_scan returns clusters; the agent distills; add_pitfalls stores them.
// ---------------------------------------------------------------------------

export interface ReviewCluster {
  id: string;
  size: number;
  suggestedCategory: string;
  /** Provenance to pass back with the distilled pitfall. */
  incidentIds: string[];
  comments: { body: string; path?: string; prNumber: number }[];
}

export interface ScanForAnalysisResult {
  clusters: ReviewCluster[];
  prsScanned: number;
  comments: number;
  substantive: number;
  incidents: number;
  totalScanned: number;
}

/**
 * Mechanical scan for the agent path: fetch new PRs, denoise, record incidents, cluster,
 * advance the cursor, and return the clusters for the agent to distill.
 */
export async function scanForAnalysis(
  repoPath: string,
  config: ReviewerConfig,
  opts: AnalyzeOptions = {},
): Promise<ScanForAnalysisResult> {
  const p = repoPaths(repoPath, config.dataDir);
  const repo = path.basename(p.repoPath);
  const prior = opts.reset ? { repo, scannedPrs: [], lastRun: '' } : await loadAnalyzeState(repoPath, config);

  const embed = requireEmbeddings(config);
  const store = knowledgeStore(config);
  const scan = await scanHistory(store, embed, config, {
    cwd: p.repoPath,
    repoName: repo,
    alreadyScanned: prior.scannedPrs,
    state: opts.state,
    order: opts.order,
    limit: opts.limit,
  });
  await saveAnalyzeState(repoPath, config, { repo, scannedPrs: scan.scannedPrs, lastRun: new Date().toISOString() });

  const clusters: ReviewCluster[] = scan.clusters.map((cl, i) => {
    const rep = [...cl.comments].sort((a, b) => b.body.length - a.body.length)[0]!;
    return {
      id: `cluster-${i}`,
      size: cl.comments.length,
      suggestedCategory: categorize(rep.body),
      incidentIds: cl.comments.map((c) => `inc:analyzed:${c.id}`),
      comments: cl.comments.map((c) => ({ body: c.body, path: c.path, prNumber: c.prNumber })),
    };
  });

  return {
    clusters,
    prsScanned: scan.prsScanned,
    comments: scan.comments,
    substantive: scan.substantive,
    incidents: scan.incidents,
    totalScanned: scan.scannedPrs.length,
  };
}

/** A pitfall distilled by the connected agent (from an analyze_scan cluster). */
export interface AgentPitfall {
  title: string;
  why: string;
  mitigation?: string;
  category: string;
  tier?: PitfallTier;
  confidence?: number;
  /** `global` (broadly applicable) or `repo` (specific to this project, still stored). */
  scope?: 'global' | 'repo';
  incidentIds?: string[];
}

/**
 * Store agent-distilled pitfalls (embedding computed here). De-duplicates **semantically** at write
 * time (`addOrReinforcePitfall`): a candidate whose principle matches an existing pitfall reinforces
 * it (no duplicate) rather than minting a near-identical lesson. Pitfalls default to `repo` scope
 * (specific to this project) unless the agent marks them `global`; `repo` is stamped so retrieval can
 * scope them (ADR-21).
 */
export async function addAnalyzedPitfalls(
  config: ReviewerConfig,
  pitfalls: AgentPitfall[],
  repo?: string,
): Promise<{ added: number; reinforced: number }> {
  const store = knowledgeStore(config);
  const embed = requireEmbeddings(config);
  // Map each provenance incident → its observed outcome, so a pitfall's default confidence is the
  // SAME Wilson lower bound the standalone distiller computes (one definition of confidence; no `0.6`
  // magic default). The agent may still pass an explicit confidence to override.
  const outcomeById = new Map((await store.incidents()).map((i) => [i.id, i.outcome]));
  let added = 0;
  let reinforced = 0;
  for (const p of pitfalls) {
    const [embedding] = await embed.embed([`${p.category}: ${p.title}\n${p.why}`]);
    const scope = p.scope ?? 'repo';
    const pitfall: Pitfall = {
      id: distilledPitfallId(p.title, repo),
      title: p.title,
      trigger: p.title,
      why: p.why,
      mitigation: p.mitigation,
      category: p.category,
      tier: p.tier ?? 'judgmental',
      confidence: p.confidence ?? confidenceFromOutcomes((p.incidentIds ?? []).map((id) => outcomeById.get(id))),
      scope,
      repo: scope === 'repo' ? repo : undefined,
      incidentIds: p.incidentIds ?? [],
      embedding,
    };
    const { action } = await addOrReinforcePitfall(store, pitfall);
    if (action === 'minted') added++;
    else reinforced++;
  }
  return { added, reinforced };
}
