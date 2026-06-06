import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ReviewerConfig,
  ReviewNeighborhood,
  CodeLocation,
  NeighborEntry,
  NormalizedDiff,
  Finding,
} from '@plex/core';
import { CodeGraphDB, buildCodeGraph, getMeta, type BuildResult } from '@plex/code-graph';
import { computeNeighborhood, publishNeighborhood } from '@plex/neighborhood';
import { runDeterministic } from '@plex/deterministic';
import type { RetrievedPitfall } from '@plex/knowledge';
import { repoPaths } from './paths';
import { resolveDiff, type DiffSource } from './diff';
import { buildKnowledgeQuery, getRelevantKnowledge } from './knowledge';

/** Full rebuild of a repo's code graph. */
export async function indexRepo(
  repoPath: string,
  config: ReviewerConfig,
): Promise<BuildResult & { graphDir: string }> {
  const p = repoPaths(repoPath, config.dataDir);
  const res = await buildCodeGraph({ repoPath: p.repoPath, dbDir: p.graphDir, coChange: config.coChange });
  return { ...res, graphDir: p.graphDir };
}

/** The grounded bundle handed to a fresh reviewing agent (ADR-02/03). */
export interface ReviewContext {
  repo: string;
  baseRef: string;
  files: { path: string; status: string; changedRanges: { start: number; end: number }[] }[];
  /** Symbol-level locations the diff touches. */
  changed: CodeLocation[];
  /** Coupled files (blast radius), ranked, with provenance. */
  blastRadius: NeighborEntry[];
  /** Codified (deterministic) findings on the changed lines — the agent should not re-derive these. */
  deterministic: Finding[];
  /** Relevant pitfalls retrieved from the knowledge base (ADR-01). */
  knowledge: RetrievedPitfall[];
  /** Contents of the repo's `plex.md`, if present (human-authored guidance — ADR-09). */
  reviewerMd?: string;
  /** FalkorDB graph name if the ephemeral layer was published. */
  ephemeralGraph?: string;
  /** Guidance for the reviewing agent. */
  notes: string[];
}

/**
 * A stable, recognizable FalkorDB graph name for a review target (instead of a random
 * timestamp): `<repo>__pr_<n>` for a PR, else `<repo>__<mode>[_<baseRef>]`. Re-reviewing
 * the same target reuses the same graph (publish clears it first).
 */
function reviewGraphName(repo: string, opts: AssembleOptions): string {
  const slug = (s: string): string => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  if (opts.source === 'pr' && opts.pr != null) return `${slug(repo)}__pr_${slug(String(opts.pr))}`;
  const mode = opts.mode ?? 'working';
  return `${slug(repo)}__${mode}${opts.baseRef ? '_' + slug(opts.baseRef) : ''}`;
}

/** Read repo-root `plex.md` (the explicit, human-editable steering surface). */
function loadReviewerMd(repoPath: string): string | undefined {
  const f = path.join(repoPath, 'plex.md');
  try {
    return existsSync(f) ? readFileSync(f, 'utf8').trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

export interface AssembleOptions extends DiffSource {
  repoPath: string;
  config: ReviewerConfig;
  /** Mirror the neighborhood into FalkorDB for live viz (requires falkordb.enabled). */
  publishFalkor?: boolean;
}

const AGENT_NOTES = [
  'You did NOT write this code. Review it with fresh, skeptical eyes.',
  'Report bugs, potential bugs, improvements, and nits. Severity (bug|improvement|nit) and confidence (0..1) are independent: a high-severity, low-confidence item is a "potential bug" — say so honestly.',
  '`blastRadius` lists files coupled to the change (co-change = historical, import = structural). Inspect them for breakage the diff might cause.',
  '`deterministic` findings are already computed — incorporate them, do not re-derive them.',
  'A pattern repeated across many files is likely a convention (demote) — unless it is a bug, in which case it is systemic (escalate as a migration).',
  'Submit findings via `submit_findings` (merged & ranked with deterministic ones); log the user\'s decision via `record_outcome`.',
];

/** Assemble the review context: diff → neighborhood → deterministic findings → optional FalkorDB. */
export async function assembleReviewContext(opts: AssembleOptions): Promise<ReviewContext> {
  const p = repoPaths(opts.repoPath, opts.config.dataDir);
  const diff = await resolveDiff(opts.repoPath, opts.config, opts);

  if (!existsSync(p.graphDir)) {
    throw new Error(`No code graph at ${p.graphDir}. Run \`reviewer index\` (or the index_repo tool) first.`);
  }

  // Query Kùzu fully, then close BEFORE any FalkorDB work (ADR-16).
  const db = new CodeGraphDB(p.graphDir);
  let repo: string;
  let nb: ReviewNeighborhood;
  try {
    repo = (await getMeta(db, 'repo')) ?? p.repoPath;
    nb = await computeNeighborhood(db, repo, diff, opts.config.neighborhood);
  } finally {
    await db.close();
  }

  const deterministic = await runDeterministic(p.repoPath, diff, { repoName: repo });

  const query = buildKnowledgeQuery(nb.changed, deterministic, diff.files.map((f) => f.path));
  const knowledge = await getRelevantKnowledge(opts.config, query, 5, repo);

  let ephemeralGraph: string | undefined;
  // Auto-publish when FalkorDB is enabled (so the Browser always reflects the latest
  // review); callers can opt out with publishFalkor: false.
  if (opts.publishFalkor !== false && opts.config.falkordb.enabled) {
    const graphName = reviewGraphName(repo, opts);
    const res = await publishNeighborhood(graphName, nb, { url: opts.config.falkordb.url });
    if (res.published) ephemeralGraph = graphName;
  }

  return {
    repo,
    baseRef: diff.baseRef,
    files: diff.files.map((f) => ({
      path: f.path,
      status: f.status,
      changedRanges: f.hunks.flatMap((h) => h.newRanges),
    })),
    changed: nb.changed,
    blastRadius: nb.neighbors,
    deterministic,
    knowledge,
    reviewerMd: loadReviewerMd(p.repoPath),
    ephemeralGraph,
    notes: AGENT_NOTES,
  };
}

/** Blast radius for a set of files (no diff) — powers the get_blast_radius tool. */
export async function blastRadius(
  repoPath: string,
  files: string[],
  config: ReviewerConfig,
): Promise<NeighborEntry[]> {
  const p = repoPaths(repoPath, config.dataDir);
  if (!existsSync(p.graphDir)) {
    throw new Error(`No code graph at ${p.graphDir}. Run \`reviewer index\` first.`);
  }
  const synthetic: NormalizedDiff = {
    baseRef: 'n/a',
    files: files.map((file) => ({ path: file, status: 'modified' as const, hunks: [] })),
  };
  const db = new CodeGraphDB(p.graphDir);
  try {
    const repo = (await getMeta(db, 'repo')) ?? p.repoPath;
    const nb = await computeNeighborhood(db, repo, synthetic, config.neighborhood);
    return nb.neighbors;
  } finally {
    await db.close();
  }
}
