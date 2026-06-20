import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, statSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
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
import { safeEmbed, RepoBusyError } from '@plex/core';
import {
  CodeGraphDB,
  buildCodeGraph,
  updateCodeGraph,
  FullRebuildRequired,
  getMeta,
  commitsBehind,
  getCoChangeEdges,
  getCouplingDegrees,
  getImportEdges,
  getRefEdges,
  type BuildResult,
  type DeletedFileEdges,
} from '@plex/code-graph';
import { computeNeighborhood, associationStrength } from '@plex/neighborhood';
import { runDeterministic } from '@plex/deterministic';
import { classifyChanges, reviewPlan, isWaived, type RegionVec, type SignalVec, type ReviewPlan } from '@plex/findings';
import { getHeadSha, getPrHeadSha, getChangedFileTexts } from '@plex/ingest';
import { fetchCommentsForPr } from '@plex/distill';
import type { RetrievedPitfall } from '@plex/knowledge';
import { repoPaths, ensureDataDir, type RepoPaths } from './paths';
import { isDebounced } from './sweep-helpers';
import { resolveDiff, type DiffSource } from './diff';
import { resolveChangeContext } from './change-context';
import { reviewTargetFor } from './target';
import { recordableHeadSha, priorRoundHeadSha } from './guards';
import { createEmbeddingProvider, buildKnowledgeGraph } from '@plex/knowledge';
import { Brain, type RoundSummary } from './brain';
import { logAudit } from './audit';
import { buildKnowledgeQuery, getRelevantKnowledge, embeddingReady, knowledgeStore } from './knowledge';
import { matchCodePath, applyCodePathBoost, type CodePathAlert } from './code-path';
import { loadWaivers } from './verdicts';
import { cachedEmbed } from './embed-cache';
import { recordFixAccepts, type AcceptedFix } from './reconcile';

/** Index a repo's code graph. Full rebuild by default; `incremental` re-extracts only changed files,
 *  falling back to a full build when an incremental update isn't possible (ADR-25). */
export async function indexRepo(
  repoPath: string,
  config: ReviewerConfig,
  opts: { incremental?: boolean } = {},
): Promise<BuildResult & { graphDir: string; incremental: boolean; seeded?: boolean; added?: number; modified?: number; deleted?: number }> {
  const p = repoPaths(repoPath, config.dataDir);
  ensureDataDir(p.reviewerDir);
  // Record this repo's path for orphan detection in `doctor gc`.
  try { writeFileSync(p.repoPathFile, p.repoPath, 'utf8'); } catch { /* best-effort */ }
  const stamp = async (): Promise<void> => {
    // Sidecar sha so reviews can check staleness WITHOUT opening Kùzu (ADR-16/25).
    try {
      mkdirSync(path.dirname(p.headShaFile), { recursive: true });
      writeFileSync(p.headShaFile, await getHeadSha(p.repoPath), 'utf8');
    } catch {
      /* best-effort */
    }
  };
  // Persist dependents of files an update DELETED into the sidecar — reviews consult it on any later
  // round (captured inside the update's own Kùzu open, pre-delete).
  const persistDeleted = (res: { deletedEdges?: DeletedFileEdges }): void => {
    if (res.deletedEdges) {
      try {
        mergeDeletedNeighborsSidecar(p.reviewerDir, weightDeletedNeighbors(res.deletedEdges));
      } catch {
        /* best-effort */
      }
    }
  };
  if (opts.incremental && existsSync(p.graphDir)) {
    try {
      const res = await updateCodeGraph({ repoPath: p.repoPath, dbDir: p.graphDir, coChange: config.coChange });
      persistDeleted(res);
      await stamp();
      return { ...res, graphDir: p.graphDir };
    } catch (e) {
      if (!(e instanceof FullRebuildRequired)) throw e;
      // fall through to a (possibly seeded) full build
    }
  }

  // No graph yet → if a secondary worktree's base is already indexed, COPY the base graph and refresh
  // it to this worktree's head instead of a full re-index. We do NOT share the base's graph read-only:
  // Kùzu 0.11.3's read-only `Database` open SIGSEGVs on Linux (ADR-32/ADR-39), so every secondary
  // worktree gets its OWN graph. (Re)seed when there's no graph yet, OR `main` advanced past the seed
  // sha AND main's graph is already fresh (cheap re-copy, ADR-43); when main moved but its graph is
  // stale the review spawns the maintenance worker "tight" instead. Full build is the fallback.
  if (!existsSync(p.graphDir) || (await baseSeedState(p, config)) === 'reseed') {
    const base = baseWorktree(p.repoPath, config);
    if (base) {
      const firstSeed = !existsSync(p.graphDir);
      if (firstSeed) indexIsolated(base.path, true); // initial seed: refresh the base to ITS OWN head (ADR-17)
      try {
        if (!firstSeed) rmSync(p.graphDir, { recursive: true, force: true }); // re-seed: drop the stale copy first
        mkdirSync(path.dirname(p.graphDir), { recursive: true });
        cpSync(base.graphDir, p.graphDir, { recursive: true });
        const res = await updateCodeGraph({ repoPath: p.repoPath, dbDir: p.graphDir, coChange: config.coChange });
        persistDeleted(res);
        try {
          writeFileSync(p.baseShaFile, await getHeadSha(base.path), 'utf8'); // record the main sha we seeded from
        } catch {
          /* best-effort */
        }
        await stamp();
        return { ...res, graphDir: p.graphDir, seeded: true };
      } catch {
        rmSync(p.graphDir, { recursive: true, force: true }); // partial/corrupt copy → fall through to a full build
      }
    }
  }

  const res = await buildCodeGraph({ repoPath: p.repoPath, dbDir: p.graphDir, coChange: config.coChange });
  await stamp();
  return { ...res, graphDir: p.graphDir, incremental: false };
}

/**
 * Resolve the canonical base checkout (`main`) from any worktree — default-branch worktree, else
 * primary, else `repoPath` (ADR-43, the maintenance sweep targets main). No graph-exists gate (unlike
 * `baseWorktree`). Best-effort: any git failure → `repoPath`.
 */
export function resolveMainRepoPath(repoPath: string): string {
  try {
    const out = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath, encoding: 'utf8' });
    if (out.status !== 0) return path.resolve(repoPath);
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
    const def = defaultBranch(repoPath);
    const onDefault = def ? wts.find((w) => w.branch === def) : undefined;
    const chosen = onDefault ?? wts[0];
    return chosen ? path.resolve(chosen.path) : path.resolve(repoPath);
  } catch {
    return path.resolve(repoPath);
  }
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
 * If `repoPath` is a secondary worktree, the worktree to seed from (default-branch one, else primary)
 * when its code graph already exists. `undefined` when this IS the primary, it isn't a worktree, or no
 * base is indexed. Never auto-checks-out the default branch.
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
    // A worktree ITSELF on the default branch is a canonical base — it must build its own graph, never
    // share the (possibly non-default) primary, else sibling feature worktrees have no base to share.
    const selfBranch = wts.find((w) => path.resolve(w.path) === self)?.branch;
    if (def && selfBranch === def) return undefined;

    const onDefault = def ? wts.find((w) => w.branch === def && path.resolve(w.path) !== self) : undefined;
    const chosen = onDefault ?? primary;
    const graphDir = repoPaths(chosen.path, config.dataDir).graphDir;
    return existsSync(graphDir) ? { path: chosen.path, graphDir } : undefined;
  } catch {
    return undefined;
  }
}

/** Read the sidecar indexed HEAD sha (no Kùzu). undefined if not indexed / pre-sidecar. */
export function readIndexedSha(headShaFile: string): string | undefined {
  try {
    return existsSync(headShaFile) ? readFileSync(headShaFile, 'utf8').trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** The `main` HEAD sha a worktree's graph was seeded from (`base.sha`). undefined if not a seeded worktree. */
function readBaseSha(baseShaFile: string): string | undefined {
  try {
    return existsSync(baseShaFile) ? readFileSync(baseShaFile, 'utf8').trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A secondary worktree's base-graph staleness vs `main` (ADR-43), comparing `base.sha` to main's HEAD:
 *  - `fresh`        — main unchanged (or not a seeded worktree).
 *  - `reseed`       — main advanced AND main's graph is fresh → cheap re-copy (indexRepo does it).
 *  - `refresh-main` — main advanced but its graph is stale → the review spawns the worker "tight".
 * Best-effort: any ambiguity → `fresh`.
 */
type BaseSeedState = 'fresh' | 'reseed' | 'refresh-main';
async function baseSeedState(p: RepoPaths, config: ReviewerConfig): Promise<BaseSeedState> {
  if (!existsSync(p.graphDir)) return 'fresh'; // first seed is the existsSync branch, not here
  const recorded = readBaseSha(p.baseShaFile);
  if (!recorded) return 'fresh'; // not a seeded worktree (or pre-base-sha)
  const base = baseWorktree(p.repoPath, config);
  if (!base) return 'fresh';
  let baseHead: string | undefined;
  try {
    baseHead = await getHeadSha(base.path);
  } catch {
    return 'fresh';
  }
  if (!baseHead || baseHead === recorded) return 'fresh'; // main unchanged since we seeded
  return readIndexedSha(repoPaths(base.path, config.dataDir).headShaFile) === baseHead ? 'reseed' : 'refresh-main';
}

/**
 * Refresh / build a graph in an ISOLATED child process (ADR-16/25): indexing must not open Kùzu in the
 * review process, which already opens it for the neighborhood (native SIGSEGV risk). Returns true if it
 * ran (false in dev/tsx with no built CLI beside argv[1]). Retries the transient Kùzu SIGSEGV (ADR-17).
 */
export function indexIsolated(repoPath: string, incremental: boolean): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const cli = path.join(path.dirname(entry), 'plex.js');
  if (!existsSync(cli)) return false;
  const args = incremental ? [cli, 'index', repoPath, '--incremental'] : [cli, 'index', repoPath];
  // Retry ONLY the transient Kùzu SIGSEGV (ADR-17) — `index` is idempotent so a fresh child recovers; a
  // real failure (non-zero exit) won't be fixed by re-running, so stop early.
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = spawnSync(process.execPath, args, { stdio: 'ignore' });
    if (r.status === 0) return true;
    if (r.signal !== 'SIGSEGV') break;
  }
  return false;
}

const SWEEP_DEBOUNCE_MS = 10 * 60 * 1000; // ≤1 background sweep per 10 min per data dir

/**
 * Fire-and-forget the background maintenance worker (ADR-43) for `main` (`spawn` + `detached` + `unref`
 * — must NOT block the triggering call). No-op in dev/tsx or when debounced; `force` bypasses the
 * debounce. Best-effort: any failure → false, never throws into the caller.
 */
export function maybeSpawnSweep(repoPath: string, config: ReviewerConfig, force = false): boolean {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const cli = path.join(path.dirname(entry), 'plex.js');
    if (!existsSync(cli)) return false; // dev/tsx: no built CLI to spawn
    const main = resolveMainRepoPath(repoPath);
    const p = repoPaths(main, config.dataDir);
    if (!force) {
      let markerMs: number | undefined;
      try {
        markerMs = statSync(p.sweepMarkerFile).mtimeMs;
      } catch {
        /* no marker yet → markerMs undefined → not debounced */
      }
      if (isDebounced(markerMs, Date.now(), SWEEP_DEBOUNCE_MS)) return false;
    }
    const child = spawn(process.execPath, [cli, 'sweep', main], { detached: true, stdio: 'ignore' });
    // A detached child reports fork failures asynchronously via 'error'; with no listener Node escalates
    // to an uncaught exception the surrounding try/catch can't catch, crashing the review. Swallow it.
    child.on('error', () => {});
    child.unref();
    // Stamp the debounce marker only AFTER spawn succeeds — a throwing spawn must not suppress
    // maintenance for the full window.
    try {
      mkdirSync(p.reviewerDir, { recursive: true });
      writeFileSync(p.sweepMarkerFile, new Date().toISOString(), 'utf8');
    } catch {
      /* best-effort */
    }
    return true;
  } catch {
    return false;
  }
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
  /** Relevant pitfalls retrieved from the knowledge base (ADR-01), boosted by code-path matches. */
  knowledge: RetrievedPitfall[];
  /** Code-path memory (ADR-47): pitfalls with recorded history at the symbols this diff touches.
   *  `regressionSentinel` flags a prior fix/accept at a symbol being changed again. Sentinels first. */
  codePathAlerts?: CodePathAlert[];
  /** Stated motivation (PR title/body or commit subjects) — check the code against its claims. */
  changeContext?: ChangeContext;
  /** Set when the code graph is behind HEAD — the blast radius may be incomplete (ADR-25). */
  graphStale?: GraphStaleness;
  /** Stable brain target id for this review (reviewTargetFor). */
  target?: string;
  /** This review's round number (1-based). */
  round?: number;
  /** Prior rounds on this target (facts that cross rounds — ADR-02). */
  priorRounds?: RoundSummary[];
  /** Regions changed since the previous round that NO prior finding or PR comment explains (ADR-23). */
  unexplainedChanges?: AttributedChange[];
  /** PR-thread comments ingested this round (facts). */
  openComments?: PrComment[];
  /** Prior-round findings auto-accepted as FIXED by this round (ADR-28) — each naming the matching
   *  signal (`semantic` | `locality`) so auto-accepts are auditable. */
  inferredAccepts?: import('./reconcile').AcceptedFix[];
  /** Parallel-review advice (parallel-review.md): `single` or `parallel` (one reviewer per coupled
   *  cluster), decided from the coupling graph. */
  reviewPlan?: ReviewPlan;
  /** Guidance for the reviewing agent. */
  notes: string[];
}

/** Undirected coupling edges AMONG the changed files (co-change ∪ import ∪ ref) for the parallel-review
 *  partition. Edges to unchanged files are dropped (those are blast radius). Deduped, self-loops removed. */
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

export interface AssembleOptions extends DiffSource {
  repoPath: string;
  config: ReviewerConfig;
  /** Auto-refresh the graph (incremental) when it has drifted behind HEAD. Default true (ADR-25). */
  autoIndex?: boolean;
}

const AGENT_NOTES = [
  'You did NOT write this code. Review it with fresh, skeptical eyes.',
  'Report bugs, potential bugs, improvements, and nits. Severity (bug|improvement|nit) and confidence (0..1) are independent axes you set on `submit_findings`: a high-severity, low-confidence item is a "potential bug". Confidence is an INTERNAL ranking input — NEVER display it (no numeric score, no "high/low confidence" wording, no certainty self-rating, in prose OR a table). Surface genuine uncertainty only by calling it a potential bug and hedging the claim itself ("may", "if X then…").',
  '`blastRadius` lists files coupled to the change (co-change = historical, import = structural). Inspect them for breakage the diff might cause. If it is EMPTY the change is isolated — focus on the changed files and do not go hunting; if you expected coupling and see none, check the staleness note (the graph may be behind HEAD).',
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
  inferredAccepts: AcceptedFix[];
}

/**
 * Build the PR-brain context for this review (ADR-22/23/30): determine the round, ingest PR comments,
 * and — when the head moved — attribute changes (ADR-23) + infer fixes (ADR-28). Embeddings are OPTIONAL
 * (ADR-30): without a provider, round/findings still record and fix inference falls back to LOCALITY;
 * only the semantic change-attribution is skipped.
 */
async function buildBrainContext(opts: AssembleOptions, repo: string, baseRef: string): Promise<BrainContext> {
  const config = opts.config;
  const cwd = repoPaths(opts.repoPath, config.dataDir).repoPath;
  // Key the brain off the BASE repo basename, NOT the graph's `repo` meta — else a worktree splits the
  // brain across names (see reviewTargetFor, ADR-46).
  const target = reviewTargetFor(opts.repoPath, opts);
  const embedder = createEmbeddingProvider(config.embedding);

  const headSha =
    opts.source === 'pr' && opts.pr != null ? await getPrHeadSha({ pr: opts.pr, cwd }) : await getHeadSha(cwd);

  const brain = await Brain.open(opts.repoPath, config);
  try {
    // Lineage is base-keyed + durable (ADR-46), so a worktree and its base share one target — no split
    // to heal (`healSplitTarget` retired).
    const state = await brain.loadRoundState(target);
    const sameRound = state.lastN > 0 && headSha !== '' && state.lastHeadSha === headSha;
    const round = sameRound ? state.lastN : state.lastN + 1;

    let comments: PrComment[] = [];
    if (opts.source === 'pr' && opts.pr != null) {
      const raw = await fetchCommentsForPr(cwd, { number: Number(opts.pr), mergedAt: null });
      comments = raw.map((c) => ({ id: c.id, file: c.path, line: c.line, body: c.body, author: c.author, createdAt: c.createdAt }));
    }

    // Attribute changes since the previous round (ADR-23) + infer fixes (ADR-28). Embeddings power the
    // SEMANTIC signals; the LOCALITY fix-match needs none (ADR-30), so run fix inference whenever the
    // head moved.
    let unexplainedChanges: AttributedChange[] = [];
    let inferredAccepts: AcceptedFix[] = [];
    // Anchor on the PRIOR round's head, not the latest — so a crash-retry that already recorded THIS
    // round reproduces the signal instead of comparing the head to itself (priorRoundHeadSha, guards.ts).
    const priorHead = priorRoundHeadSha(state.rounds, round);
    if (state.lastN > 0 && priorHead && headSha && priorHead !== headSha) {
      const changed = await getChangedFileTexts(cwd, priorHead, headSha);
      if (changed.length > 0) {
        // Locality-only by default (empty vectors → semantic never fires); a provider fills these below.
        let regionEmb: number[][] = changed.map(() => []);
        let findingEmb: number[][] = state.priorFindings.map(() => []);
        if (embedder) {
          const signals = [
            ...state.signals,
            ...comments.map((c) => ({ text: c.body, label: `comment: ${c.body.slice(0, 60)}` })),
          ].filter((s) => s.text.trim());

          // Changes with NO signal explaining them are "unexplained" (M6) — needs NO embeddings, so mark
          // it up front. (With signals present, classifyChanges decides below.)
          if (signals.length === 0) {
            unexplainedChanges = changed.map((c) => ({ file: c.file, start: c.start, end: c.end, attribution: 'unexplained' as const }));
          }

          // Embeddings only buy classifying changes against signals + semantic fix-match against prior
          // findings. With neither, locality covers it — skip the batch (the bulk of wasted embed spend).
          if (signals.length > 0 || state.priorFindings.length > 0) {
            const regionTexts = changed.map((c) => c.text);
            // Per-round CONTENT — embed fresh. safeEmbed caps + chunks the batch (B-G1) and returns null
            // on a transient failure (m5) → locality-only, never a hard fail.
            const vecs = await safeEmbed(embedder, [...regionTexts, ...signals.map((s) => s.text)]);
            // Finding TITLES recur round over round — serve from the cache so each embeds ONCE. null if
            // a cache miss had to be embedded and that embed failed; degrade like `vecs` null.
            const findingVecs = await cachedEmbed(
              embedder,
              repoPaths(opts.repoPath, config.dataDir).embedCacheFile,
              state.priorFindings.map((f) => f.title),
            );
            if (vecs && signals.length > 0) {
              regionEmb = changed.map((_, i) => vecs[i] ?? []);
              const regionVecs: RegionVec[] = changed.map((c, i) => ({ file: c.file, start: c.start, end: c.end, embedding: regionEmb[i]! }));
              const signalVecs: SignalVec[] = signals.map((s, i) => ({ embedding: vecs[regionTexts.length + i] ?? [], label: s.label }));
              unexplainedChanges = classifyChanges(regionVecs, signalVecs).filter((a) => a.attribution === 'unexplained');
            } else if (vecs) {
              regionEmb = changed.map((_, i) => vecs[i] ?? []); // for semantic fix-match only
            }
            if (findingVecs) findingEmb = state.priorFindings.map((_, i) => findingVecs[i] ?? []);
          }
        }
        // Always run fix inference — locality reconciles restructuring fixes with no provider (ADR-30).
        inferredAccepts = await recordFixAccepts(opts.repoPath, config, target, brain, state.priorFindings, findingEmb, regionEmb, changed);
      }
    }

    // An empty headSha would poison the next round's attribution anchor (#2/#9); carry the last known
    // anchor forward so the round still records (recordableHeadSha). Skip + log only when there's none.
    const recordSha = recordableHeadSha(headSha, state.lastHeadSha);
    if (recordSha) {
      await brain.recordRound(target, { target, n: round, ts: new Date().toISOString(), headSha: recordSha, baseRef }, comments);
    } else {
      const where = opts.source === 'pr' && opts.pr != null ? `PR #${opts.pr}` : 'HEAD';
      process.stderr.write(`[plex] could not resolve ${where} sha for ${target} (no prior anchor); skipping round record\n`);
    }

    return { target, round, priorRounds: state.rounds, unexplainedChanges, openComments: comments, inferredAccepts };
  } finally {
    await brain.close();
  }
}

/**
 * Weight the raw edges `updateCodeGraph` captured for DELETED files into per-file neighbor entries
 * (distance 1). Pure: capture happens inside the update's own Kùzu open (re-opening the same dir in one
 * process SIGSEGVs).
 */
function weightDeletedNeighbors(raw: DeletedFileEdges): Map<string, NeighborEntry[]> {
  const deletedSet = new Set(raw.deletedPaths);
  const best = new Map<string, Map<string, { score: number; via: Set<NeighborEntry['via'][number]> }>>();
  const add = (src: string, dst: string, w: number, via: NeighborEntry['via'][number]): void => {
    if (deletedSet.has(dst) || w <= 0) return;
    const perFile = best.get(src) ?? new Map();
    const cur = perFile.get(dst) ?? { score: 0, via: new Set<NeighborEntry['via'][number]>() };
    cur.score = Math.max(cur.score, Math.min(1, w));
    cur.via.add(via);
    perFile.set(dst, cur);
    best.set(src, perFile);
  };
  const deg = (f: string, fallback: number): number => raw.coDegrees[f] ?? fallback;
  for (const e of raw.co) add(e.src, e.dst, associationStrength(e.weight, deg(e.src, e.weight), deg(e.dst, e.weight)), 'co-change');
  for (const e of raw.imports) add(e.src, e.dst, 0.4, 'import');
  for (const e of raw.refs) add(e.src, e.dst, 0.5, 'precise-ref');
  const out = new Map<string, NeighborEntry[]>();
  for (const [src, perFile] of best) {
    out.set(src, [...perFile].map(([id, v]) => ({
      node: { id, label: 'File' as const, props: { path: id } },
      score: v.score,
      via: [...v.via],
      distance: 1,
    })));
  }
  return out;
}

// The incremental update DETACH-DELETEs a deleted file's node, after which its dependents are
// unrecoverable from the graph — so `indexRepo` captures them at deletion time into this sidecar, which
// reviews consult for the diff's deleted files on ANY later round. Best-effort JSON; capped.

const DELETED_SIDECAR_CAP = 500;
interface DeletedSidecarEntry {
  ts: number;
  neighbors: NeighborEntry[];
}

function deletedSidecarFile(reviewerDir: string): string {
  return path.join(reviewerDir, 'deleted-neighbors.json');
}

function readDeletedNeighborsSidecar(reviewerDir: string): Record<string, DeletedSidecarEntry> {
  try {
    return JSON.parse(readFileSync(deletedSidecarFile(reviewerDir), 'utf8')) as Record<string, DeletedSidecarEntry>;
  } catch {
    return {};
  }
}

function mergeDeletedNeighborsSidecar(reviewerDir: string, captured: Map<string, NeighborEntry[]>): void {
  try {
    const sidecar = readDeletedNeighborsSidecar(reviewerDir);
    const now = Date.now();
    for (const [file, neighbors] of captured) sidecar[file] = { ts: now, neighbors };
    const entries = Object.entries(sidecar).sort((a, b) => b[1].ts - a[1].ts).slice(0, DELETED_SIDECAR_CAP);
    mkdirSync(reviewerDir, { recursive: true });
    writeFileSync(deletedSidecarFile(reviewerDir), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* best-effort — a missing sidecar degrades to the old (empty) behavior */
  }
}

export async function assembleReviewContext(opts: AssembleOptions): Promise<ReviewContext> {
  const p = repoPaths(opts.repoPath, opts.config.dataDir);
  const [diff, changeContext] = await Promise.all([
    resolveDiff(opts.repoPath, opts.config, opts),
    resolveChangeContext(opts.repoPath, opts.config, opts),
  ]);

  // A secondary worktree has its OWN graph (copied by `indexRepo`, ADR-32/ADR-39), opened normally —
  // NOT shared read-only (Kùzu's read-only open SIGSEGVs on Linux). So `graphP` is this repo's own dir.
  const graphP = p;
  ensureDataDir(p.reviewerDir);

  // Auto-index on first use (ADR-30): build/seed this repo's graph in an ISOLATED child.
  if (!existsSync(graphP.graphDir)) {
    if (opts.autoIndex !== false) indexIsolated(graphP.repoPath, false);
    if (!existsSync(graphP.graphDir)) {
      throw new Error(`No code graph at ${graphP.graphDir}, and auto-index could not run. Run \`plex index ${opts.repoPath}\` first.`);
    }
  }

  // Keep the graph fresh BEFORE computing blast radius (ADR-25): staleness from the sidecar sha (no
  // Kùzu), any refresh in an ISOLATED child.
  let graphStale: GraphStaleness | undefined;
  {
    const indexedSha = readIndexedSha(graphP.headShaFile);
    const behind = indexedSha ? await commitsBehind(graphP.repoPath, indexedSha) : -1;
    if (indexedSha && behind > 0 && opts.autoIndex !== false) {
      const refreshed = indexIsolated(graphP.repoPath, true);
      graphStale = { indexedSha, behind, refreshed };
    } else if (!indexedSha || behind !== 0) {
      graphStale = { indexedSha, behind, refreshed: false };
    }
  }

  // Query Kùzu fully, then close (ADR-16) — ONE open, normal mode.
  const changedPaths = diff.files.map((f) => f.path);
  // A detached sweep (ADR-43) may briefly hold the graph's single-writer lock; the foreground review
  // retries the open/query on a transient `RepoBusyError` (~3s budget). The lock can surface at open OR
  // lazily at first query, so the retry wraps both.
  let result: { repo: string; nb: ReviewNeighborhood; coupling: [string, string][]; couplingDeg: Map<string, number> } | undefined;
  for (let attempt = 0; result === undefined; attempt++) {
    let db: CodeGraphDB | undefined;
    try {
      db = new CodeGraphDB(graphP.graphDir);
      const repo = (await getMeta(db, 'repo')) ?? p.repoPath;
      const nb = await computeNeighborhood(db, repo, diff, opts.config.neighborhood);
      const coupling = await changedFileCoupling(db, changedPaths);
      const couplingDeg = await getCouplingDegrees(db, changedPaths); // for per-finding blast enrichment
      result = { repo, nb, coupling, couplingDeg };
    } catch (e) {
      if (!(e instanceof RepoBusyError) || attempt >= 20) throw e;
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      if (db) await db.close().catch(() => {});
    }
  }
  const { repo, nb, coupling, couplingDeg } = result;

  // Merge dependents of COMMITTED deletions from the sidecar — their nodes were DETACH-DELETEd by the
  // update, so the walk couldn't see them. Direct entries, deduped against the walk, re-sorted + re-capped.
  // (Uncommitted deletions keep their node and were already seeded by the walk.)
  const deletedDiffFiles = diff.files.filter((f) => f.status === 'deleted').map((f) => f.path);
  if (deletedDiffFiles.length > 0) {
    const sidecar = readDeletedNeighborsSidecar(graphP.reviewerDir);
    const captured = deletedDiffFiles.flatMap((f) => sidecar[f]?.neighbors ?? []);
    if (captured.length > 0) {
      const have = new Set(nb.neighbors.map((n) => String(n.node.props.path)));
      const changedSet = new Set(changedPaths);
      for (const n of captured) {
        const pth = String(n.node.props.path);
        if (!have.has(pth) && !changedSet.has(pth)) {
          nb.neighbors.push(n);
          have.add(pth);
        }
      }
      nb.neighbors.sort((a, b) => b.score - a.score);
      nb.neighbors = nb.neighbors.slice(0, opts.config.neighborhood.maxNeighbors);
      for (const f of deletedDiffFiles) {
        if (!nb.changed.some((c) => c.file === f)) nb.changed.push({ repo, file: f, startLine: 1, endLine: 1 });
      }
    }
  }

  // Persist a per-file blast map for submit_findings to enrich each finding's `blast` (tuning.md §5),
  // computed HERE while the graph is open so submit needs no extra Kùzu open (ADR-17). Best-effort.
  try {
    const maxDeg = Math.max(1, ...[...couplingDeg.values()]);
    const files: Record<string, number> = {};
    for (const [f, d] of couplingDeg) files[f] = d / maxDeg;
    for (const n of nb.neighbors) files[String(n.node.props.path)] = n.score;
    writeFileSync(path.join(p.reviewerDir, 'blast-map.json'), JSON.stringify({ target: reviewTargetFor(opts.repoPath, opts), files }));
  } catch {
    /* best-effort: blast enrichment is optional */
  }

  // Parallel-review guardrail (ADR-34/parallel-review): advise single vs fan-out from the coupling
  // graph alone. `surface` ≈ total changed lines.
  const surface = diff.files.reduce(
    (s, f) => s + f.hunks.reduce((h, hk) => h + hk.newRanges.reduce((r, rg) => r + (rg.end - rg.start + 1), 0), 0),
    0,
  );
  const plan = reviewPlan(changedPaths, coupling, { surface, ...opts.config.reviewPlan });

  // Codified findings, minus any the user has waived — the SAME `loadWaivers`/`isWaived` suppression
  // `rankFindings` applies at submit time, pulled earlier so a waived rule never primes the agent.
  // Identity-only (no embeddings); submit-time still adds the semantic pass.
  const detRaw = await runDeterministic(p.repoPath, diff, { repoName: repo });
  // Only EXPLICIT suppressions (`waive`/`acknowledge`) keep a rule from priming the agent — a `reject`
  // ("not now") must NOT (the weighted negative-knowledge path, not a permanent kill; C1).
  const detWaivers = await loadWaivers(p.repoPath, opts.config, new Set(['waive', 'acknowledge']));
  const deterministic = detWaivers.length ? detRaw.filter((f) => !isWaived(f, detWaivers)) : detRaw;

  const query = buildKnowledgeQuery(nb.changed, deterministic, diff.files.map((f) => f.path));
  const retrieved = await getRelevantKnowledge(opts.config, query, 5, repo);
  // Code-path memory (ADR-47): match retrieved pitfalls' incident history against the diff's changed
  // symbols + co-change neighbours. Pure JS, no extra Kùzu open (ADR-17), works without embeddings.
  // NOTE: the graph's symbol/file indexes are incident-COMPLETE (every store incident), NOT scoped to
  // the retrieved/repo set — a future consumer reaching for them here must scope themselves.
  const kg = buildKnowledgeGraph(retrieved.map((r) => r.pitfall), await knowledgeStore(opts.config).incidents());
  const cp = matchCodePath(retrieved, kg, nb.changed, nb.neighbors);
  const knowledge = applyCodePathBoost(retrieved, cp.boostByPitfall);
  const sentinelCount = cp.alerts.filter((a) => a.regressionSentinel).length;
  // Cold-start nudge: only when nothing was retrieved AND the store is empty. Gated on embeddings (the
  // seed path `analyze` needs them).
  const coldKnowledge =
    knowledge.length === 0 && embeddingReady(opts.config) && (await knowledgeStore(opts.config).pitfalls()).length === 0;

  // PR brain (ADR-22/23/30): rounds, comments, findings + the changed-without-feedback + fix-inference
  // signals (the latter when embeddings are configured).
  const brain = await buildBrainContext(opts, repo, diff.baseRef);
  const target = brain.target;
  const round = brain.round;

  // Attribution audit log (ADR-24) — logs what was PROVIDED, not reasoning.
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

  // Background maintenance worker (ADR-43): now this review's Kùzu opens are closed, fire-and-forget a
  // debounced sweep. Force it "tight" when the base copy is stale and main needs refreshing first.
  // Best-effort; never blocks or breaks the review.
  try {
    const seedState = await baseSeedState(repoPaths(opts.repoPath, opts.config.dataDir), opts.config);
    maybeSpawnSweep(opts.repoPath, opts.config, seedState === 'refresh-main');
  } catch {
    /* best-effort */
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
    codePathAlerts: cp.alerts.length ? cp.alerts : undefined,
    changeContext,
    graphStale,
    target,
    round: brain.round,
    priorRounds: brain.priorRounds,
    unexplainedChanges: brain.unexplainedChanges,
    openComments: brain.openComments,
    inferredAccepts: brain.inferredAccepts.length > 0 ? brain.inferredAccepts : undefined,
    reviewPlan: plan,
    notes: [
      ...AGENT_NOTES,
      ...BRAIN_NOTES,
      ...(embeddingReady(opts.config)
        ? []
        : [
            'Embeddings are OFF (no provider configured): lessons from review history were retrieved by keyword match only (weaker than semantic retrieval), and the semantic signals (change attribution, semantic waiver matching) were skipped. In your closing "what Plex brought" line you may note this and point them to `npx @sshanzel/plex init` (one short clause; never ask for the key in chat).',
          ]),
      ...(coldKnowledge
        ? [
            "Plex has no learned lessons for this repo yet (cold start). State briefly, as a fact (not a pitch), that Plex sharpens as it reviews — and that seeding it from the repo's merged PR history (run `plex analyze`, or ask the agent to analyze the PR history) jump-starts that by analyzing past review comments into lessons anchored to the code. Mention this once, in your closing 'what Plex brought' line.",
          ]
        : []),
      ...(cp.alerts.length
        ? [
            `Code-path memory: ${cp.alerts.length} retrieved lesson(s) have prior recorded history at code paths this diff touches` +
              (sentinelCount
                ? `, including ${sentinelCount} REGRESSION SENTINEL(s) — a concern previously fixed/accepted at a symbol you're changing AGAIN. Treat sentinels as high-priority "verify you are not regressing this"; cite the prior history. See codePathAlerts.`
                : '. See codePathAlerts.') +
              ` These are grounded in THIS repo's recorded review history at these exact symbols — not generic lints.`,
          ]
        : []),
      plan.strategy === 'parallel'
        ? `reviewPlan: PARALLEL — ${plan.reason}. Fan out one reviewer per unit (orchestrate with the plex-parallel-review skill); collect their findings into ONE submit_findings, then cross-check across units.`
        : `reviewPlan: single — ${plan.reason}. Review in one pass.`,
      ...(diff.generatedPaths?.length
        ? [
            `${diff.generatedPaths.length} machine-generated file(s) changed in this diff but are excluded from review (${diff.generatedPaths.join(', ')}). Mention this as a fact; a lockfile change with NO matching manifest edit can be a supply-chain signal worth confirming.`,
          ]
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
