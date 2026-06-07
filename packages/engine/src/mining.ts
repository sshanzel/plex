import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ReviewerConfig, Pitfall, PitfallTier } from '@plex/core';
import { mineHistory, scanHistory, categorize, minedPitfallId, type MineResult } from '@plex/mining';
import { knowledgeStore, requireEmbeddings } from './knowledge';
import { repoPaths } from './paths';

/** Per-repo incremental mining cursor (ADR-11): which PRs have been scanned. */
export interface MiningState {
  repo: string;
  scannedPrs: number[];
  lastRun: string;
}

export async function loadMiningState(
  repoPath: string,
  config: ReviewerConfig,
): Promise<MiningState> {
  const p = repoPaths(repoPath, config.dataDir);
  try {
    return JSON.parse(await fs.readFile(p.miningStateFile, 'utf8')) as MiningState;
  } catch {
    return { repo: path.basename(p.repoPath), scannedPrs: [], lastRun: '' };
  }
}

async function saveMiningState(repoPath: string, config: ReviewerConfig, state: MiningState): Promise<void> {
  const p = repoPaths(repoPath, config.dataDir);
  await fs.mkdir(path.dirname(p.miningStateFile), { recursive: true });
  await fs.writeFile(p.miningStateFile, JSON.stringify(state, null, 2), 'utf8');
}

export interface MineRepoOptions {
  /** Re-scan from scratch, ignoring the saved cursor. */
  reset?: boolean;
  state?: 'merged' | 'all';
  /** `oldest` = chronological (PR #1 up); default newest-first. */
  order?: 'newest' | 'oldest';
  /** Max fresh PRs to scan this run (the cursor advances for the next run). */
  limit?: number;
}

/**
 * Mine a repo's PR history into the knowledge base, incrementally — only PRs not in the
 * saved cursor are pulled, and the cursor is updated afterward (ADR-11).
 */
export async function mineRepo(
  repoPath: string,
  config: ReviewerConfig,
  opts: MineRepoOptions = {},
): Promise<MineResult & { totalScanned: number }> {
  const p = repoPaths(repoPath, config.dataDir);
  const repo = path.basename(p.repoPath);
  const prior = opts.reset ? { repo, scannedPrs: [], lastRun: '' } : await loadMiningState(repoPath, config);

  const embed = requireEmbeddings(config);
  const store = knowledgeStore(config);
  const { result, scannedPrs } = await mineHistory(store, embed, config, {
    cwd: p.repoPath,
    repoName: repo,
    alreadyScanned: prior.scannedPrs,
    state: opts.state,
    order: opts.order,
    limit: opts.limit,
  });

  await saveMiningState(repoPath, config, { repo, scannedPrs, lastRun: new Date().toISOString() });
  return { ...result, totalScanned: scannedPrs.length };
}

// ---------------------------------------------------------------------------
// Agent-driven mining (rides the connected agent's subscription — no API key).
// mine_scan returns clusters; the agent distills; add_pitfalls stores them.
// ---------------------------------------------------------------------------

export interface MiningCluster {
  id: string;
  size: number;
  suggestedCategory: string;
  /** Provenance to pass back with the distilled pitfall. */
  incidentIds: string[];
  comments: { body: string; path?: string; prNumber: number }[];
}

export interface ScanForMiningResult {
  clusters: MiningCluster[];
  prsScanned: number;
  comments: number;
  substantive: number;
  incidents: number;
  totalScanned: number;
}

/**
 * Mechanical mining scan for the agent path: fetch new PRs, denoise, record incidents,
 * cluster, advance the cursor, and return the clusters for the agent to distill.
 */
export async function scanForMining(
  repoPath: string,
  config: ReviewerConfig,
  opts: MineRepoOptions = {},
): Promise<ScanForMiningResult> {
  const p = repoPaths(repoPath, config.dataDir);
  const repo = path.basename(p.repoPath);
  const prior = opts.reset ? { repo, scannedPrs: [], lastRun: '' } : await loadMiningState(repoPath, config);

  const embed = requireEmbeddings(config);
  const store = knowledgeStore(config);
  const scan = await scanHistory(store, embed, config, {
    cwd: p.repoPath,
    repoName: repo,
    alreadyScanned: prior.scannedPrs,
    state: opts.state,
  });
  await saveMiningState(repoPath, config, { repo, scannedPrs: scan.scannedPrs, lastRun: new Date().toISOString() });

  const clusters: MiningCluster[] = scan.clusters.map((cl, i) => {
    const rep = [...cl.comments].sort((a, b) => b.body.length - a.body.length)[0]!;
    return {
      id: `cluster-${i}`,
      size: cl.comments.length,
      suggestedCategory: categorize(rep.body),
      incidentIds: cl.comments.map((c) => `inc:mined:${c.id}`),
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

/** A pitfall distilled by the connected agent (from a mine_scan cluster). */
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
 * Store agent-distilled pitfalls (embedding computed here). Dedups by title. Pitfalls
 * default to `repo` scope (mined from a specific project) unless the agent marks them
 * `global`; `repo` is stamped so retrieval can scope them (ADR-21).
 */
export async function addMinedPitfalls(
  config: ReviewerConfig,
  pitfalls: AgentPitfall[],
  repo?: string,
): Promise<{ added: number }> {
  const store = knowledgeStore(config);
  const embed = requireEmbeddings(config);
  let added = 0;
  for (const p of pitfalls) {
    if (await store.hasPitfallTitled(p.title)) continue;
    const [embedding] = await embed.embed([`${p.category}: ${p.title}\n${p.why}`]);
    const scope = p.scope ?? 'repo';
    const pitfall: Pitfall = {
      id: minedPitfallId(p.title, repo),
      title: p.title,
      trigger: p.title,
      why: p.why,
      mitigation: p.mitigation,
      category: p.category,
      tier: p.tier ?? 'judgmental',
      confidence: p.confidence ?? 0.6,
      scope,
      repo: scope === 'repo' ? repo : undefined,
      incidentIds: p.incidentIds ?? [],
      embedding,
    };
    await store.addPitfall(pitfall);
    added++;
  }
  return { added };
}
