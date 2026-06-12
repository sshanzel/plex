import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { ReviewerConfig } from '@plex/core';
import { isLockError } from '@plex/core';
import { getHeadSha, getPrHeadSha } from '@plex/ingest';
import { repoPaths } from './paths';
import { Brain } from './brain';
import { diffSourceFromTarget } from './target';
import { reconcileOutcomes } from './reconcile';
import { consolidateKnowledge, embeddingReady } from './knowledge';
import { analyzeRepo } from './analyze';
import { indexIsolated, readIndexedSha, resolveMainRepoPath } from './review';

/**
 * The background maintenance worker (ADR-43). It is the reliable owner of every deferred Plex job
 * that otherwise only runs when someone runs a manual command on `main` — which nobody does. Spawned
 * best-effort + detached by ordinary Plex activity (`maybeSpawnSweep`, review.ts), it **maintains
 * `main` as the canonical, always-fresh base**: it resolves main from any worktree, then runs four
 * idempotent jobs against main's centralized + durable data dir (so it sidesteps the ADR-40
 * worktree-brain death). It supersedes both the flaky pr-responder loop-closing and the git hooks
 * ADR-36 removed. See docs/design/maintenance-worker.md.
 *
 * EVERY job is idempotent (re-running changes nothing): reconcile rides `submitVerdict`'s
 * learning-idempotency + a per-target head cursor; consolidate is a pure overwrite; index is a no-op
 * when fresh; analyze rides the `analyze-state.json` scan cursor. So a sweep can fire as often as the
 * debounce allows without duplicating work.
 */

const CONSOLIDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // recompute decay/prune at most every 6h (cheap, slow-moving)
const ANALYZE_INTERVAL_MS = 24 * 60 * 60 * 1000; // distil new merged PRs at most daily (heaviest job)
const STALE_LOCK_MS = 30 * 60 * 1000; // a lock older than this is from a crashed sweep — steal it

export interface SweepState {
  repo: string;
  /** Per reconcile-target: the head sha we last swept it at (head unchanged → skip). */
  cursors: Record<string, string>;
  /** Per cadence-gated job: ISO ts of its last run (consolidate / analyze). */
  jobs: Record<string, string>;
}

export interface JobResult {
  name: string;
  ran: boolean;
  detail: string;
  /** A job left work undone because the brain was locked by a concurrent review — retry next sweep. */
  busy?: boolean;
}

export interface SweepResult {
  repo: string;
  mainRepoPath: string;
  jobs: JobResult[];
  busy: boolean;
  /** True when another sweep already held the single-flight lock (this call did nothing). */
  locked: boolean;
}

// --- pure decision helpers (unit-tested without I/O) ---------------------------------------------

/** Has main's head advanced past the per-target cursor? Undefined cursor → yes (first sweep). An
 *  unresolved head → false (nothing to do). */
export function headAdvanced(cursor: string | undefined, currentHead: string | undefined): boolean {
  if (!currentHead) return false;
  return cursor !== currentHead;
}

/** Debounce: true (skip) when the marker is younger than the interval. Undefined marker → never debounced. */
export function isDebounced(markerMtimeMs: number | undefined, nowMs: number, intervalMs: number): boolean {
  return markerMtimeMs != null && nowMs - markerMtimeMs < intervalMs;
}

/** Cadence gate for a periodic job: true (run) when it has never run or the interval has elapsed. */
export function jobDue(lastRunIso: string | undefined, nowMs: number, intervalMs: number): boolean {
  if (!lastRunIso) return true;
  const t = Date.parse(lastRunIso);
  return Number.isNaN(t) || nowMs - t >= intervalMs;
}

// --- state + lock IO (best-effort) ----------------------------------------------------------------

function loadSweepState(file: string, repo: string): SweepState {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Partial<SweepState>;
    return { repo, cursors: s.cursors ?? {}, jobs: s.jobs ?? {} };
  } catch {
    return { repo, cursors: {}, jobs: {} };
  }
}

function saveSweepState(file: string, state: SweepState): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    /* best-effort */
  }
}

/** Acquire the single-flight lock (one sweep per data dir). Returns false if another sweep holds a
 *  FRESH lock; steals a stale one (a crashed sweep). Best-effort. */
function acquireLock(lockFile: string, nowMs: number): boolean {
  try {
    mkdirSync(path.dirname(lockFile), { recursive: true });
    closeSync(openSync(lockFile, 'wx'));
    return true;
  } catch {
    try {
      if (nowMs - statSync(lockFile).mtimeMs > STALE_LOCK_MS) {
        unlinkSync(lockFile);
        closeSync(openSync(lockFile, 'wx'));
        return true;
      }
    } catch {
      /* lost the race / vanished — treat as held */
    }
    return false;
  }
}

const releaseLock = (lockFile: string): void => {
  try {
    unlinkSync(lockFile);
  } catch {
    /* already gone */
  }
};

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// --- the four jobs --------------------------------------------------------------------------------

interface JobCtx {
  mainRepoPath: string;
  cwd: string;
  config: ReviewerConfig;
  now: Date;
  state: SweepState;
}

/** Job 1 — loop closure: reconcile main's open findings whose head advanced (the reliable
 *  replacement for the pr-responder's `reconcile_outcomes`). */
async function reconcileJob(ctx: JobCtx): Promise<JobResult> {
  const { mainRepoPath, cwd, config, state } = ctx;
  let targets: Awaited<ReturnType<Brain['openTargets']>>;
  const brain = await Brain.open(mainRepoPath, config);
  try {
    targets = await brain.openTargets();
  } finally {
    await brain.close();
  }
  let accepted = 0;
  let swept = 0;
  let busy = false;
  for (const t of targets) {
    const src = diffSourceFromTarget(t.target, t.baseRef);
    if (!src) continue;
    let head: string | undefined;
    try {
      head = src.source === 'pr' && src.pr != null ? await getPrHeadSha({ pr: src.pr, cwd }) : await getHeadSha(cwd);
    } catch {
      continue; // can't resolve this target's head (e.g. a closed PR) → skip
    }
    if (!headAdvanced(state.cursors[t.target], head)) continue; // cursor no-op
    try {
      const r = await reconcileOutcomes(mainRepoPath, config, src);
      accepted += r.accepted;
      swept++;
      if (head) state.cursors[t.target] = head; // advance only on success (even if accepted 0 — head checked)
    } catch (e) {
      if (isLockError(e)) busy = true; // leave cursor unadvanced → retry next sweep
      // any other error: best-effort, leave cursor, continue
    }
  }
  return { name: 'reconcile', ran: swept > 0, detail: `${accepted} auto-closed across ${swept}/${targets.length} target(s)`, busy };
}

/** Job 2 — base-graph freshness: re-index main to its HEAD when the graph drifted, so every future
 *  branch copy seeds from a current main. */
async function graphFreshnessJob(ctx: JobCtx): Promise<JobResult> {
  const { mainRepoPath, config } = ctx;
  const p = repoPaths(mainRepoPath, config.dataDir);
  let head: string | undefined;
  try {
    head = await getHeadSha(p.repoPath);
  } catch {
    return { name: 'graph', ran: false, detail: 'head unresolved' };
  }
  const indexed = readIndexedSha(p.headShaFile);
  if (indexed === head) return { name: 'graph', ran: false, detail: 'graph fresh' };
  // Index in an ISOLATED child (ADR-17), exactly as the review does — NEVER in-process: the sweep
  // already opens the brain (reconcile job), and opening the code graph for a write in the same
  // process SIGSEGVs Kùzu. `indexIsolated` spawns `node dist/plex.js index` and waits; it no-ops in
  // dev/tsx (no built CLI beside argv[1]), so the graph just stays as-is there.
  const ran = indexIsolated(mainRepoPath, !!indexed); // incremental if a graph exists, else full build
  return { name: 'graph', ran, detail: ran ? `re-indexed main → ${head.slice(0, 8)}` : 'index skipped (no built CLI / dev)' };
}

/** Job 3 — consolidation: apply the positive-decay + pruning (ADR-42) to the global KB. WITHOUT this
 *  job that decay is dormant (nobody runs `plex consolidate`). Cadence-gated; cheap/offline. */
async function consolidateJob(ctx: JobCtx): Promise<JobResult> {
  const { config, now, state } = ctx;
  if (!jobDue(state.jobs.consolidate, now.getTime(), CONSOLIDATE_INTERVAL_MS)) return { name: 'consolidate', ran: false, detail: 'ran recently' };
  const r = await consolidateKnowledge(config, now);
  state.jobs.consolidate = now.toISOString();
  return { name: 'consolidate', ran: true, detail: `reinforced ${r.reinforced}/${r.pitfalls}, pruned ${r.pruned}` };
}

/** Job 4 — incremental analyze: distil newly-merged PR review history into pitfalls. Gated on a real
 *  embedding provider + an LLM being available; the heaviest job (tokens), so it runs last + daily. */
async function analyzeJob(ctx: JobCtx): Promise<JobResult> {
  const { mainRepoPath, config, now, state } = ctx;
  if (!embeddingReady(config)) return { name: 'analyze', ran: false, detail: 'no embeddings — skipped' };
  if (!jobDue(state.jobs.analyze, now.getTime(), ANALYZE_INTERVAL_MS)) return { name: 'analyze', ran: false, detail: 'ran recently' };
  try {
    const r = await analyzeRepo(mainRepoPath, config);
    state.jobs.analyze = now.toISOString(); // only stamp on success
    return { name: 'analyze', ran: true, detail: `scanned ${r.totalScanned} PR(s)` };
  } catch (e) {
    return { name: 'analyze', ran: false, detail: `skipped: ${errMsg(e)}` }; // no LLM / rate limit → degrade
  }
}

// --- the runner -----------------------------------------------------------------------------------

/**
 * Run the maintenance jobs against `main` (resolved from `repoPath`). Single-flight + best-effort:
 * each job is isolated in try/catch (one failing never blocks the next), and the whole run never
 * throws — it is spawned fire-and-forget. Returns a structured summary for the CLI/manual path.
 */
export async function sweepRepo(repoPath: string, config: ReviewerConfig, now: Date = new Date()): Promise<SweepResult> {
  const mainRepoPath = resolveMainRepoPath(repoPath);
  const repo = path.basename(mainRepoPath);
  const p = repoPaths(mainRepoPath, config.dataDir);
  const empty: SweepResult = { repo, mainRepoPath, jobs: [], busy: false, locked: false };
  if (!acquireLock(p.sweepLockFile, now.getTime())) return { ...empty, locked: true };
  try {
    const state = loadSweepState(p.sweepStateFile, repo);
    const ctx: JobCtx = { mainRepoPath, cwd: p.repoPath, config, now, state };
    const jobs = [reconcileJob, graphFreshnessJob, consolidateJob, analyzeJob];
    const results: JobResult[] = [];
    let busy = false;
    for (const job of jobs) {
      try {
        const r = await job(ctx);
        results.push(r);
        if (r.busy) busy = true;
      } catch (e) {
        results.push({ name: job.name.replace(/Job$/, ''), ran: false, detail: `error: ${errMsg(e)}` });
      }
    }
    saveSweepState(p.sweepStateFile, state);
    return { repo, mainRepoPath, jobs: results, busy, locked: false };
  } finally {
    releaseLock(p.sweepLockFile);
  }
}
