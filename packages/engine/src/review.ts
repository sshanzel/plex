import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  getCoChangeEdges,
  getImportEdges,
  getRefEdges,
  type BuildResult,
} from '@plex/code-graph';
import { computeNeighborhood } from '@plex/neighborhood';
import { runDeterministic } from '@plex/deterministic';
import { classifyChanges, reviewPlan, type RegionVec, type SignalVec, type ReviewPlan } from '@plex/findings';
import { getHeadSha, getPrHeadSha, getChangedFileTexts } from '@plex/ingest';
import { fetchCommentsForPr } from '@plex/mining';
import type { RetrievedPitfall } from '@plex/knowledge';
import { repoPaths, ensureDataDir } from './paths';
import { resolveDiff, type DiffSource } from './diff';
import { resolveChangeContext } from './change-context';
import { reviewTarget } from './target';
import { createEmbeddingProvider } from '@plex/knowledge';
import { Brain, type RoundSummary } from './brain';
import { logAudit } from './audit';
import { buildKnowledgeQuery, getRelevantKnowledge } from './knowledge';
import { recordFixAccepts } from './reconcile';

/**
 * Index a repo's code graph. Full rebuild by default; `incremental` re-extracts only the
 * files changed since the graph's stored `headSha` and falls back to a full build when an
 * incremental update isn't possible (no prior graph / rewritten history — ADR-25).
 */
export async function indexRepo(
  repoPath: string,
  config: ReviewerConfig,
  opts: { incremental?: boolean } = {},
): Promise<BuildResult & { graphDir: string; incremental: boolean; seeded?: boolean; added?: number; modified?: number; deleted?: number }> {
  const p = repoPaths(repoPath, config.dataDir);
  ensureDataDir(p.reviewerDir); // self-ignoring data dir — an in-repo `.plex` never needs hand-gitignoring
  const stamp = async (): Promise<void> => {
    // Sidecar sha so reviews can check staleness WITHOUT opening Kùzu (ADR-16): a second
    // Kùzu open in a process that also spawns the FalkorDB worker risks SIGSEGV.
    try {
      mkdirSync(path.dirname(p.headShaFile), { recursive: true });
      writeFileSync(p.headShaFile, await getHeadSha(p.repoPath), 'utf8');
    } catch {
      /* best-effort */
    }
  };
  if (opts.incremental && existsSync(p.graphDir)) {
    try {
      const res = await updateCodeGraph({ repoPath: p.repoPath, dbDir: p.graphDir, coChange: config.coChange });
      await stamp();
      return { ...res, graphDir: p.graphDir };
    } catch (e) {
      if (!(e instanceof FullRebuildRequired)) throw e;
      // fall through to a (possibly seeded) full build
    }
  }

  // No graph yet → if this is a secondary git worktree whose BASE (the default-branch
  // checkout) is already indexed, refresh that base to ITS OWN head, then COPY it and
  // incrementally apply only this branch's diff (ADR-32). Only main's state ever lands in
  // the base (a worktree's branch data never does), and the copy is independent — so N
  // worktrees can't pollute the base, and a fresh worktree is seconds, not a full re-parse.
  if (!existsSync(p.graphDir)) {
    const base = baseWorktree(p.repoPath, config);
    if (base) {
      // Refresh the base to ITS OWN head in an ISOLATED child (ADR-17): opening the base's
      // Kùzu in *this* process and then opening the copied graph below is two opens in one
      // process — a SIGSEGV. The child keeps us to a single open here. Best-effort: in dev/tsx
      // (no built CLI beside argv[1]) it no-ops and the incremental below reconciles any drift.
      indexIsolated(base.path, true);
      try {
        mkdirSync(path.dirname(p.graphDir), { recursive: true });
        cpSync(base.graphDir, p.graphDir, { recursive: true });
        const res = await updateCodeGraph({ repoPath: p.repoPath, dbDir: p.graphDir, coChange: config.coChange });
        await stamp();
        return { ...res, graphDir: p.graphDir, seeded: true };
      } catch {
        rmSync(p.graphDir, { recursive: true, force: true }); // partial/corrupt copy → full build
      }
    }
  }

  const res = await buildCodeGraph({ repoPath: p.repoPath, dbDir: p.graphDir, coChange: config.coChange });
  await stamp();
  return { ...res, graphDir: p.graphDir, incremental: false };
}

/** The repo's default branch (`origin/HEAD`, else `main`/`master`). undefined if unknown. */
function defaultBranch(repoPath: string): string | undefined {
  const r = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoPath, encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master']) {
    if (spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], { cwd: repoPath }).status === 0) return b;
  }
  return undefined;
}

/**
 * If `repoPath` is a secondary git worktree, return the worktree to seed from — preferring
 * the one on the **default branch** (the canonical base), else the primary worktree — when
 * its code graph already exists. `undefined` when this *is* the primary worktree, it isn't a
 * worktree, or no base is indexed. We never auto-checkout the default branch (that would
 * disrupt the user's worktrees); if it isn't checked out anywhere we fall back to primary.
 */
function baseWorktree(repoPath: string, config: ReviewerConfig): { path: string; graphDir: string } | undefined {
  try {
    const out = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath, encoding: 'utf8' });
    if (out.status !== 0) return undefined;
    const wts: { path: string; branch?: string }[] = [];
    let cur: { path: string; branch?: string } | null = null;
    for (const line of out.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        cur = { path: line.slice('worktree '.length) };
        wts.push(cur);
      } else if (line.startsWith('branch ') && cur) {
        cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      }
    }
    const self = path.resolve(repoPath);
    const primary = wts[0];
    if (!primary || path.resolve(primary.path) === self) return undefined; // we ARE the primary/base

    const def = defaultBranch(repoPath);
    const onDefault = def ? wts.find((w) => w.branch === def && path.resolve(w.path) !== self) : undefined;
    const chosen = onDefault ?? primary;
    const graphDir = repoPaths(chosen.path, config.dataDir).graphDir;
    return existsSync(graphDir) ? { path: chosen.path, graphDir } : undefined;
  } catch {
    return undefined;
  }
}

/** Read the sidecar indexed HEAD sha (no Kùzu). undefined if not indexed / pre-sidecar. */
function readIndexedSha(headShaFile: string): string | undefined {
  try {
    return existsSync(headShaFile) ? readFileSync(headShaFile, 'utf8').trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refresh / build a graph in an ISOLATED child process (ADR-16/25): indexing opens Kùzu, and
 * doing that in the review process — which also opens Kùzu for the neighborhood + brain —
 * risks the native SIGSEGV. Spawning `plex index` keeps the review process to ONE Kùzu open.
 * Returns true if it ran (false in dev/tsx where the built CLI isn't beside argv[1]).
 *
 * Retries once on failure. A rare native Kùzu crash (ADR-17) can fail a single index — most
 * relevantly the worktree-seed full build, which opens the copied base graph. The retry of a
 * full build self-heals: a partial graph from the crashed attempt makes the next `plex index`
 * skip the seed and fall to `buildCodeGraph`, which clears the dir first and rebuilds clean.
 */
function indexIsolated(repoPath: string, incremental: boolean): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const cli = path.join(path.dirname(entry), 'plex.js');
  if (!existsSync(cli)) return false;
  const args = incremental ? [cli, 'index', repoPath, '--incremental'] : [cli, 'index', repoPath];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (spawnSync(process.execPath, args, { stdio: 'ignore' }).status === 0) return true;
  }
  return false;
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
  /** Prior findings auto-recorded as fixed this round because a change addressed them (ADR-28). */
  inferredOutcomes?: number;
  /**
   * Parallel-review advice (parallel-review.md): `single` (one reviewer) or `parallel` (fan
   * out one reviewer per coupled cluster — the `units`), decided from the coupling graph. The
   * orchestrator obeys this; consolidation is one `submit_findings` over all units' findings.
   */
  reviewPlan?: ReviewPlan;
  /** Guidance for the reviewing agent. */
  notes: string[];
}

/** Undirected coupling edges AMONG the changed files (co-change ∪ import ∪ ref) — the input
 *  to the parallel-review partition. Edges to *unchanged* files are dropped (those are blast
 *  radius, not review units). Deduped, self-loops removed. */
async function changedFileCoupling(db: CodeGraphDB, files: string[]): Promise<[string, string][]> {
  if (files.length < 2) return [];
  const inDiff = new Set(files);
  const [cc, imp, ref] = await Promise.all([getCoChangeEdges(db, files), getImportEdges(db, files), getRefEdges(db, files)]);
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const e of [...cc, ...imp, ...ref]) {
    if (e.src === e.dst || !inDiff.has(e.dst)) continue;
    const key = e.src < e.dst ? `${e.src}\t${e.dst}` : `${e.dst}\t${e.src}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([e.src, e.dst]);
  }
  return out;
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
  'Submit findings via `submit_findings` (merged & ranked with deterministic ones), then STOP — do NOT ask the user whether to accept/reject/waive. Plex records outcomes autonomously: a finding addressed by a later change is auto-accepted. `record_outcome` is for an EXPLICIT dismissal only (e.g. the responder skill when the author pushes back on a thread).',
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
  /** Prior findings auto-accepted this round because a change addressed them (ADR-28). */
  inferredOutcomes: number;
}

/**
 * Build the PR-brain context for this review (ADR-22/23): determine the round, ingest PR
 * comments, attribute what changed since last round (semantic — embeddings REQUIRED, no
 * heuristic; ADR-13), and persist the round to FalkorDB. Throws if FalkorDB/embeddings are
 * unavailable — the brain has no fallback.
 */
async function buildBrainContext(opts: AssembleOptions, repo: string, baseRef: string): Promise<BrainContext> {
  const config = opts.config;
  const cwd = repoPaths(opts.repoPath, config.dataDir).repoPath;
  const target = reviewTarget(repo, opts);
  // Embeddings are now OPTIONAL (ADR-30): without a provider the brain still records rounds
  // and findings; only the semantic signals (unexplained changes + fix inference) are skipped.
  const embedder = createEmbeddingProvider(config.embedding);

  const headSha =
    opts.source === 'pr' && opts.pr != null ? await getPrHeadSha({ pr: opts.pr, cwd }) : await getHeadSha(cwd);

  const brain = await Brain.open(opts.repoPath, config);
  try {
    const state = await brain.loadRoundState(target);
    const sameRound = state.lastN > 0 && headSha !== '' && state.lastHeadSha === headSha;
    const round = sameRound ? state.lastN : state.lastN + 1;

    let comments: PrComment[] = [];
    if (opts.source === 'pr' && opts.pr != null) {
      const raw = await fetchCommentsForPr(cwd, { number: Number(opts.pr), mergedAt: null });
      comments = raw.map((c) => ({ id: c.id, file: c.path, line: c.line, body: c.body, author: c.author, createdAt: c.createdAt }));
    }

    // Attribute changes since the previous round (ADR-23) + infer fixes (ADR-28) — needs an
    // embedder; both run off one batch of embeddings (regions, signals, prior findings).
    let unexplainedChanges: AttributedChange[] = [];
    let inferredOutcomes = 0;
    if (embedder && state.lastN > 0 && state.lastHeadSha && headSha && state.lastHeadSha !== headSha) {
      const changed = await getChangedFileTexts(cwd, state.lastHeadSha, headSha);
      if (changed.length > 0) {
        const signals = [
          ...state.signals,
          ...comments.map((c) => ({ text: c.body, label: `comment: ${c.body.slice(0, 60)}` })),
        ].filter((s) => s.text.trim());
        const regionTexts = changed.map((c) => c.text);
        const findingTexts = state.priorFindings.map((f) => f.title);
        const vecs = await embedder.embed([...regionTexts, ...signals.map((s) => s.text), ...findingTexts]);
        const regionEmb = changed.map((_, i) => vecs[i] ?? []);

        if (signals.length > 0) {
          const regionVecs: RegionVec[] = changed.map((c, i) => ({ file: c.file, start: c.start, end: c.end, embedding: regionEmb[i]! }));
          const signalVecs: SignalVec[] = signals.map((s, i) => ({ embedding: vecs[regionTexts.length + i] ?? [], label: s.label }));
          unexplainedChanges = classifyChanges(regionVecs, signalVecs).filter((a) => a.attribution === 'unexplained');
        } else {
          unexplainedChanges = changed.map((c) => ({ file: c.file, start: c.start, end: c.end, attribution: 'unexplained' as const }));
        }

        const fBase = regionTexts.length + signals.length;
        const findingEmb = state.priorFindings.map((_, i) => vecs[fBase + i] ?? []);
        inferredOutcomes = await recordFixAccepts(opts.repoPath, config, target, brain, state.priorFindings, findingEmb, regionEmb);
      }
    }

    await brain.recordRound(target, { target, n: round, ts: new Date().toISOString(), headSha: headSha || undefined, baseRef }, comments);

    return { target, round, priorRounds: state.rounds, unexplainedChanges, openComments: comments, inferredOutcomes };
  } finally {
    await brain.close();
  }
}

/** Assemble the review context: diff → neighborhood → deterministic findings → optional FalkorDB. */
export async function assembleReviewContext(opts: AssembleOptions): Promise<ReviewContext> {
  const p = repoPaths(opts.repoPath, opts.config.dataDir);
  const [diff, changeContext] = await Promise.all([
    resolveDiff(opts.repoPath, opts.config, opts),
    resolveChangeContext(opts.repoPath, opts.config, opts),
  ]);

  // Auto-index on first use (ADR-30): if the repo was never indexed, build the graph in an
  // ISOLATED child process so THIS process opens Kùzu only for the neighborhood + brain. The
  // user never has to run `plex index` first.
  if (!existsSync(p.graphDir)) {
    if (opts.autoIndex !== false) indexIsolated(p.repoPath, false);
    if (!existsSync(p.graphDir)) {
      throw new Error(`No code graph at ${p.graphDir}, and auto-index could not run. Run \`plex index\` first.`);
    }
  }

  // Keep the graph fresh BEFORE computing blast radius (ADR-25). Staleness is read from the
  // SIDECAR sha (no Kùzu), and any refresh runs in an ISOLATED child process — so THIS process
  // opens Kùzu only for the neighborhood + brain below. Only a definite drift (behind > 0)
  // auto-refreshes; an unknown sha (-1) is merely reported.
  let graphStale: GraphStaleness | undefined;
  {
    const indexedSha = readIndexedSha(p.headShaFile);
    const behind = indexedSha ? await commitsBehind(p.repoPath, indexedSha) : -1;
    if (indexedSha && behind > 0 && opts.autoIndex !== false) {
      const refreshed = indexIsolated(p.repoPath, true);
      graphStale = { indexedSha, behind, refreshed };
    } else if (!indexedSha || behind !== 0) {
      graphStale = { indexedSha, behind, refreshed: false };
    }
  }

  // Query Kùzu fully (now fresh), then close (ADR-16) — ONE open. We also pull the coupling
  // AMONG the changed files here (for the parallel-review partition) so it's the same open.
  const changedPaths = diff.files.map((f) => f.path);
  const db = new CodeGraphDB(p.graphDir);
  let repo: string;
  let nb: ReviewNeighborhood;
  let coupling: [string, string][] = [];
  try {
    repo = (await getMeta(db, 'repo')) ?? p.repoPath;
    nb = await computeNeighborhood(db, repo, diff, opts.config.neighborhood);
    coupling = await changedFileCoupling(db, changedPaths);
  } finally {
    await db.close();
  }

  // Parallel-review guardrail (ADR-34/parallel-review): advise single vs fan-out from the
  // coupling graph alone (zero LLM). `surface` ≈ total changed lines.
  const surface = diff.files.reduce(
    (s, f) => s + f.hunks.reduce((h, hk) => h + hk.newRanges.reduce((r, rg) => r + (rg.end - rg.start + 1), 0), 0),
    0,
  );
  const plan = reviewPlan(changedPaths, coupling, { surface, ...opts.config.reviewPlan });

  const deterministic = await runDeterministic(p.repoPath, diff, { repoName: repo });

  const query = buildKnowledgeQuery(nb.changed, deterministic, diff.files.map((f) => f.path));
  const knowledge = await getRelevantKnowledge(opts.config, query, 5, repo);

  // PR brain (ADR-22/23/30): embedded Kùzu, always on — rounds, comments, findings, and the
  // semantic "changed-without-feedback" + fix-inference signals (the latter when embeddings
  // are configured). No service, no Docker.
  const brain = await buildBrainContext(opts, repo, diff.baseRef);
  const target = brain.target;
  const round = brain.round;

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
    unexplainedChanges: brain.unexplainedChanges.length,
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
    round: brain.round,
    priorRounds: brain.priorRounds,
    unexplainedChanges: brain.unexplainedChanges,
    openComments: brain.openComments,
    inferredOutcomes: brain.inferredOutcomes,
    reviewPlan: plan,
    notes: [
      ...AGENT_NOTES,
      ...BRAIN_NOTES,
      plan.strategy === 'parallel'
        ? `reviewPlan: PARALLEL — ${plan.reason}. Fan out one reviewer per unit (orchestrate with the pr-parallel-review skill); collect their findings into ONE submit_findings, then cross-check across units.`
        : `reviewPlan: single — ${plan.reason}. Review in one pass.`,
      ...(brain.inferredOutcomes > 0
        ? [`Plex auto-recorded ${brain.inferredOutcomes} prior finding(s) as fixed (a change since addressed them) — do not re-raise or ask to confirm those.`]
        : []),
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
