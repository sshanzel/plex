import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ReviewerConfig,
  ReviewNeighborhood,
  CodeLocation,
  NeighborEntry,
  NormalizedDiff,
  Finding,
  ChangeContext,
  PrComment,
  AttributedChange,
} from '@plex/core';
import {
  CodeGraphDB,
  buildCodeGraph,
  updateCodeGraph,
  FullRebuildRequired,
  getMeta,
  commitsBehind,
  type BuildResult,
} from '@plex/code-graph';
import { computeNeighborhood } from '@plex/neighborhood';
import { runDeterministic } from '@plex/deterministic';
import { classifyChanges, type RegionVec, type SignalVec } from '@plex/findings';
import { getHeadSha, getPrHeadSha, getChangedFileTexts } from '@plex/ingest';
import { fetchCommentsForPr } from '@plex/mining';
import type { RetrievedPitfall } from '@plex/knowledge';
import { repoPaths } from './paths';
import { resolveDiff, type DiffSource } from './diff';
import { resolveChangeContext } from './change-context';
import { reviewTarget } from './target';
import { brainEnabled, loadRoundState, recordRound, type RoundSummary } from './brain';
import { logAudit } from './audit';
import { buildKnowledgeQuery, getRelevantKnowledge, requireEmbeddings } from './knowledge';

/**
 * Index a repo's code graph. Full rebuild by default; `incremental` re-extracts only the
 * files changed since the graph's stored `headSha` and falls back to a full build when an
 * incremental update isn't possible (no prior graph / rewritten history — ADR-25).
 */
export async function indexRepo(
  repoPath: string,
  config: ReviewerConfig,
  opts: { incremental?: boolean } = {},
): Promise<BuildResult & { graphDir: string; incremental: boolean; added?: number; modified?: number; deleted?: number }> {
  const p = repoPaths(repoPath, config.dataDir);
  if (opts.incremental && existsSync(p.graphDir)) {
    try {
      const res = await updateCodeGraph({ repoPath: p.repoPath, dbDir: p.graphDir, coChange: config.coChange });
      return { ...res, graphDir: p.graphDir };
    } catch (e) {
      if (!(e instanceof FullRebuildRequired)) throw e;
      // fall through to a full rebuild
    }
  }
  const res = await buildCodeGraph({ repoPath: p.repoPath, dbDir: p.graphDir, coChange: config.coChange });
  return { ...res, graphDir: p.graphDir, incremental: false };
}

/** Is the code graph behind the working HEAD? (ADR-25 staleness signal.) */
export interface GraphStaleness {
  indexedSha?: string;
  /** Commits HEAD is ahead of the indexed sha (0 = fresh, -1 = unknown). */
  behind: number;
  /** True when the review auto-refreshed the graph (incremental) before proceeding. */
  refreshed?: boolean;
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
  /** Stated motivation (PR title/body or commit subjects) — check the code against its claims. */
  changeContext?: ChangeContext;
  /** Contents of the repo's `plex.md`, if present (human-authored guidance — ADR-09). */
  reviewerMd?: string;
  /** Set when the code graph is behind HEAD — the blast radius may be incomplete (ADR-25). */
  graphStale?: GraphStaleness;
  // --- PR brain (M6, ADR-22/23) — present when FalkorDB is enabled ---
  /** Stable target id / FalkorDB graph name for this review. */
  target?: string;
  /** This review's round number (1-based). */
  round?: number;
  /** Prior rounds on this target (facts that cross rounds — ADR-02). */
  priorRounds?: RoundSummary[];
  /**
   * Regions changed since the previous round that NO prior finding or PR comment explains
   * (semantic match — ADR-23). The highest-priority thing for the fresh reviewer to check.
   */
  unexplainedChanges?: AttributedChange[];
  /** PR-thread comments ingested this round (facts). */
  openComments?: PrComment[];
  /** FalkorDB graph name if the brain/ephemeral layer was published. */
  ephemeralGraph?: string;
  /** Guidance for the reviewing agent. */
  notes: string[];
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
  /** Auto-refresh the graph (incremental) when it has drifted behind HEAD. Default true (ADR-25). */
  autoIndex?: boolean;
}

const AGENT_NOTES = [
  'You did NOT write this code. Review it with fresh, skeptical eyes.',
  'Report bugs, potential bugs, improvements, and nits. Severity (bug|improvement|nit) and confidence (0..1) are independent: a high-severity, low-confidence item is a "potential bug" — say so honestly.',
  '`blastRadius` lists files coupled to the change (co-change = historical, import = structural). Inspect them for breakage the diff might cause.',
  '`deterministic` findings are already computed — incorporate them, do not re-derive them.',
  '`changeContext` is the author\'s STATED intent (PR title/description or commit subjects) — NOT ground truth. Check the code against it: flag where the diff does less than it claims, does something the description omits, or contradicts the stated motivation.',
  'A pattern repeated across many files is likely a convention (demote) — unless it is a bug, in which case it is systemic (escalate as a migration).',
  'Submit findings via `submit_findings` (merged & ranked with deterministic ones); log the user\'s decision via `record_outcome`.',
];

const BRAIN_NOTES = [
  '`unexplainedChanges` are regions that changed since the last round with NO prior finding or PR comment explaining them — scrutinize these FIRST; nobody asked for them.',
  '`priorRounds` and `openComments` are FACTS from earlier rounds (not prior reasoning — ADR-02): use them to stay consistent across rounds without re-deriving or anchoring on past opinions.',
];

interface BrainContext {
  target: string;
  round: number;
  priorRounds: RoundSummary[];
  unexplainedChanges: AttributedChange[];
  openComments: PrComment[];
}

/**
 * Build the PR-brain context for this review (ADR-22/23): determine the round, ingest PR
 * comments, attribute what changed since last round (semantic — embeddings REQUIRED, no
 * heuristic; ADR-13), and persist the round to FalkorDB. Throws if FalkorDB/embeddings are
 * unavailable — the brain has no fallback.
 */
async function buildBrainContext(
  opts: AssembleOptions,
  repo: string,
  nb: ReviewNeighborhood,
  baseRef: string,
): Promise<BrainContext> {
  const config = opts.config;
  const cwd = repoPaths(opts.repoPath, config.dataDir).repoPath;
  const target = reviewTarget(repo, opts);
  const embedder = requireEmbeddings(config); // brain matching needs real embeddings (ADR-13)

  const headSha =
    opts.source === 'pr' && opts.pr != null ? await getPrHeadSha({ pr: opts.pr, cwd }) : await getHeadSha(cwd);

  // requireFalkor: throws a clear "run pnpm db:up" if FalkorDB is unreachable.
  const state = await loadRoundState(target, config);
  const sameRound = state.lastN > 0 && headSha !== '' && state.lastHeadSha === headSha;
  const round = sameRound ? state.lastN : state.lastN + 1;

  let comments: PrComment[] = [];
  if (opts.source === 'pr' && opts.pr != null) {
    const raw = await fetchCommentsForPr(cwd, { number: Number(opts.pr), mergedAt: null });
    comments = raw.map((c) => ({ id: c.id, file: c.path, line: c.line, body: c.body, author: c.author, createdAt: c.createdAt }));
  }

  // Attribute changes since the previous round: feedback-driven vs unexplained (ADR-23).
  let unexplainedChanges: AttributedChange[] = [];
  if (state.lastN > 0 && state.lastHeadSha && headSha && state.lastHeadSha !== headSha) {
    const changed = await getChangedFileTexts(cwd, state.lastHeadSha, headSha);
    const signals = [
      ...state.signals,
      ...comments.map((c) => ({ text: c.body, label: `comment: ${c.body.slice(0, 60)}` })),
    ].filter((s) => s.text.trim());
    if (changed.length > 0 && signals.length > 0) {
      const regionTexts = changed.map((c) => c.text);
      const signalTexts = signals.map((s) => s.text);
      const vecs = await embedder.embed([...regionTexts, ...signalTexts]);
      const regionVecs: RegionVec[] = changed.map((c, i) => ({ file: c.file, start: c.start, end: c.end, embedding: vecs[i] ?? [] }));
      const signalVecs: SignalVec[] = signals.map((s, i) => ({ embedding: vecs[regionTexts.length + i] ?? [], label: s.label }));
      unexplainedChanges = classifyChanges(regionVecs, signalVecs).filter((a) => a.attribution === 'unexplained');
    } else if (changed.length > 0) {
      // No prior findings/comments to explain anything → everything that moved is unexplained.
      unexplainedChanges = changed.map((c) => ({ file: c.file, start: c.start, end: c.end, attribution: 'unexplained' as const }));
    }
  }

  await recordRound(
    target,
    repo,
    { target, n: round, ts: new Date().toISOString(), headSha: headSha || undefined, baseRef },
    nb,
    comments,
    config,
  );

  return { target, round, priorRounds: state.rounds, unexplainedChanges, openComments: comments };
}

/** Assemble the review context: diff → neighborhood → deterministic findings → optional FalkorDB. */
export async function assembleReviewContext(opts: AssembleOptions): Promise<ReviewContext> {
  const p = repoPaths(opts.repoPath, opts.config.dataDir);
  const [diff, changeContext] = await Promise.all([
    resolveDiff(opts.repoPath, opts.config, opts),
    resolveChangeContext(opts.repoPath, opts.config, opts),
  ]);

  if (!existsSync(p.graphDir)) {
    throw new Error(`No code graph at ${p.graphDir}. Run \`reviewer index\` (or the index_repo tool) first.`);
  }

  // Keep the graph fresh BEFORE computing blast radius (ADR-25): if it has drifted behind
  // HEAD, auto-refresh it incrementally so the neighborhood is never silently stale. Only a
  // definite drift (behind > 0) triggers it — an unknown sha (-1) or missing graph is only
  // reported, since refreshing those would mean a surprise full rebuild mid-review.
  let graphStale: GraphStaleness | undefined;
  {
    const sdb = new CodeGraphDB(p.graphDir);
    let indexedSha: string | undefined;
    try {
      indexedSha = (await getMeta(sdb, 'headSha')) ?? undefined;
    } finally {
      await sdb.close();
    }
    const behind = indexedSha ? await commitsBehind(p.repoPath, indexedSha) : -1;
    if (indexedSha && behind > 0 && opts.autoIndex !== false) {
      await indexRepo(p.repoPath, opts.config, { incremental: true });
      graphStale = { indexedSha, behind, refreshed: true };
    } else if (!indexedSha || behind !== 0) {
      graphStale = { indexedSha, behind, refreshed: false };
    }
  }

  // Query Kùzu fully (now fresh), then close BEFORE any FalkorDB work (ADR-16).
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

  // PR brain (ADR-22/23): required when FalkorDB is enabled — rounds, comments, and the
  // semantic "changed-without-feedback" signal. No in-process fallback.
  const brain = brainEnabled(opts.config) ? await buildBrainContext(opts, repo, nb, diff.baseRef) : undefined;
  const target = brain?.target ?? reviewTarget(repo, opts);
  const round = brain?.round ?? 1;

  // Attribution audit log (ADR-24) — graph-independent; logs what was PROVIDED, not reasoning.
  await logAudit(opts.repoPath, opts.config, {
    type: 'context_assembled',
    repo,
    target,
    round,
    ts: new Date().toISOString(),
    baseRef: diff.baseRef,
    files: diff.files.map((f) => f.path),
    blastRadius: nb.neighbors.map((n) => ({ path: String(n.node.props.path), score: n.score, via: n.via })),
    knowledge: knowledge.map((k) => ({ id: k.pitfall.id, score: k.score })),
    changeContext: changeContext != null,
    unexplainedChanges: brain?.unexplainedChanges.length ?? 0,
  });

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
    changeContext,
    reviewerMd: loadReviewerMd(p.repoPath),
    graphStale,
    target,
    round: brain ? brain.round : undefined,
    priorRounds: brain?.priorRounds,
    unexplainedChanges: brain?.unexplainedChanges,
    openComments: brain?.openComments,
    ephemeralGraph: brain?.target,
    notes: [
      ...AGENT_NOTES,
      ...(brain ? BRAIN_NOTES : []),
      ...(graphStale?.refreshed
        ? [`The code graph was ${graphStale.behind} commit(s) behind HEAD and was auto-refreshed (incremental) before this review — blast radius is current.`]
        : graphStale
          ? [
              `The code graph is ${graphStale.behind > 0 ? `${graphStale.behind} commit(s) behind` : 'out of sync with'} HEAD — blast radius may miss recently-changed or brand-new files. Re-index (\`plex index --incremental\`).`,
            ]
          : []),
    ],
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
