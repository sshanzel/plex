import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ReviewerConfig, Pitfall, PitfallTier, Incident, IncidentOutcome } from '@plex/core';
import {
  distillHistory,
  scanHistory,
  categorize,
  distilledPitfallId,
  listPrs,
  fetchCommentsForPr,
  outcomeFor,
  type PrRef,
  type DistillResult,
  type LearnedLesson,
} from '@plex/distill';
import { confidenceFromOutcomes, addOrReinforcePitfall } from '@plex/knowledge';
import { knowledgeStore, requireEmbeddings, consolidateKnowledge } from './knowledge';
import { repoPaths } from './paths';

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

/** Analyze a repo's PR review history into the knowledge base, incrementally (ADR-11). */
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

/** Scan for the agent path: fetch new PRs, record incidents, cluster, advance the cursor. */
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

/** Store agent-distilled pitfalls, deduping semantically at write time; default `repo` scope (ADR-21). */
export async function addAnalyzedPitfalls(
  config: ReviewerConfig,
  pitfalls: AgentPitfall[],
  repo?: string,
): Promise<{ added: number; reinforced: number; learned: LearnedLesson[] }> {
  const store = knowledgeStore(config);
  const embed = requireEmbeddings(config);
  const outcomeById = new Map((await store.incidents()).map((i) => [i.id, i.outcome]));
  let added = 0;
  let reinforced = 0;
  const learned: LearnedLesson[] = [];
  for (const p of pitfalls) {
    const [embedding] = await embed.embed([`${p.category}: ${p.title}\n${p.why}`]);
    const scope = p.scope ?? 'repo';
    const incidentIds = p.incidentIds ?? [];
    const pitfall: Pitfall = {
      id: distilledPitfallId(p.title, repo),
      title: p.title,
      trigger: p.title,
      why: p.why,
      mitigation: p.mitigation,
      category: p.category,
      tier: p.tier ?? 'judgmental',
      confidence: p.confidence ?? confidenceFromOutcomes(incidentIds.map((id) => outcomeById.get(id))),
      scope,
      repo: scope === 'repo' ? repo : undefined,
      incidentIds,
      embedding,
    };
    const r = await addOrReinforcePitfall(store, pitfall);
    if (r.action === 'minted') added++;
    else reinforced++;
    learned.push({ title: r.title, scope: r.scope, incidents: r.incidents, files: r.files, action: r.action });
  }
  return { added, reinforced, learned };
}

// Outcome backfill (ADR-50): re-derive analyzed incidents' outcomes from current GitHub state.

const ANALYZED_PREFIX = 'inc:analyzed:';
const isAnalyzedIncident = (i: Incident): boolean => i.source === 'analyzed' && i.id.startsWith(ANALYZED_PREFIX);
/** Confirm strength so backfill only ever UPGRADES an outcome (monotonic, never downgrades on a fetch miss). */
const outcomeRank = (o?: IncidentOutcome): number =>
  o === 'fixed' || o === 'accepted' || o === 'reverted' ? 2 : o === 'corroborated' ? 1 : 0;
const isConfirm = (o?: IncidentOutcome): boolean => outcomeRank(o) > 0;

export interface RefreshOutcomesResult {
  /** Could `gh` list the repo's PRs? `false` = repo not checked out here / not authed → safe no-op. */
  repoReachable: boolean;
  prsScanned: number;
  /** Total `inc:analyzed:*` incidents in the store. */
  analyzedIncidents: number;
  /** Analyzed incidents whose source comment was successfully re-fetched. */
  matched: number;
  /** Incidents whose outcome was upgraded this run (abstain→corroborated/fixed, or corroborated→fixed). */
  upgraded: number;
  /** Analyzed incidents now carrying a confirm (`fixed`/`accepted`/`reverted`/`corroborated`). */
  confirms: number;
  reason: string;
}

/**
 * Backfill analyzed incidents' outcomes from current GitHub state, then consolidate (ADR-50).
 * Invariants (load-bearing): only ever touches `source:'analyzed'` incidents (live `review` accepts
 * pass through untouched); never downgrades (a confirm only replaces a weaker outcome, so a fetch miss
 * leaves the incident as-is); idempotent; safe no-op when the repo is unreachable.
 */
export async function refreshAnalyzedOutcomes(
  repoPath: string,
  config: ReviewerConfig,
  opts: {
    state?: 'merged' | 'all';
    fetch?: { listPrs: typeof listPrs; fetchCommentsForPr: typeof fetchCommentsForPr };
  } = {},
): Promise<RefreshOutcomesResult> {
  const p = repoPaths(repoPath, config.dataDir);
  const store = knowledgeStore(config);
  const api = opts.fetch ?? { listPrs, fetchCommentsForPr };

  const incidents = await store.incidents();
  const analyzed = incidents.filter(isAnalyzedIncident);
  const base = { prsScanned: 0, analyzedIncidents: analyzed.length, matched: 0, upgraded: 0 };
  if (analyzed.length === 0) {
    return { repoReachable: true, ...base, confirms: 0, reason: 'no analyzed incidents to refresh' };
  }

  let prs: PrRef[];
  try {
    prs = await api.listPrs({ cwd: p.repoPath, maxPrs: config.analyze.maxPrs, state: opts.state ?? 'merged' });
  } catch {
    // `gh` can't resolve the repo (not checked out / not authed) — safe no-op.
    return {
      repoReachable: false,
      ...base,
      confirms: analyzed.filter((i) => isConfirm(i.outcome)).length,
      reason: `repo not reachable via gh at ${p.repoPath} (not checked out or not authenticated) — nothing refreshed`,
    };
  }

  // Only successfully-fetched comments appear; a fetch miss is absent → the incident is never downgraded.
  const fetchedOutcome = new Map<string, IncidentOutcome | undefined>();
  for (const pr of prs) {
    for (const c of await api.fetchCommentsForPr(p.repoPath, pr)) {
      fetchedOutcome.set(`${ANALYZED_PREFIX}${c.id}`, outcomeFor(c));
    }
  }

  let matched = 0;
  let upgraded = 0;
  const next = incidents.map((i) => {
    if (!isAnalyzedIncident(i) || !fetchedOutcome.has(i.id)) return i;
    matched++;
    const candidate = fetchedOutcome.get(i.id);
    if (outcomeRank(candidate) > outcomeRank(i.outcome)) {
      upgraded++;
      return { ...i, outcome: candidate };
    }
    return i;
  });

  if (upgraded > 0) {
    await store.replaceIncidents(next);
    await consolidateKnowledge(config);
  }

  const confirms = next.filter((i) => isAnalyzedIncident(i) && isConfirm(i.outcome)).length;
  return {
    repoReachable: true,
    prsScanned: prs.length,
    analyzedIncidents: analyzed.length,
    matched,
    upgraded,
    confirms,
    reason:
      upgraded > 0
        ? `upgraded ${upgraded} of ${matched} matched analyzed incidents; ${confirms} now confirm`
        : `no upgrades (${matched} of ${analyzed.length} analyzed incidents matched; outcomes already current)`,
  };
}
