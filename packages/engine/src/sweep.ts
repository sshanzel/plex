import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, statSync, unlinkSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { ReviewerConfig } from '@plex/core';
import { isLockError } from '@plex/core';
import { getHeadSha, getPrHeadSha, getPrState } from '@plex/ingest';
import { repoPaths } from './paths';
import { Brain } from './brain';
import { diffSourceFromTarget } from './target';
import { reconcileOutcomes } from './reconcile';
import { consolidateKnowledge, embeddingReady } from './knowledge';
import { analyzeRepo } from './analyze';
import { indexIsolated, readIndexedSha, resolveMainRepoPath } from './review';
import { CLOSED_TARGET, deadPrSentinel, headAdvanced, isDeadTarget, isPidAlive, jobDue } from './sweep-helpers';

// Re-export the pure decision helpers so the engine barrel + sweep.test keep a single import surface.
export { headAdvanced, isDebounced, jobDue } from './sweep-helpers';

/**
 * The background maintenance worker (ADR-43): spawned detached by ordinary Plex activity
 * (`maybeSpawnSweep`), it maintains `main` (resolved from any worktree) via four jobs against main's
 * centralized + durable data dir. Each job is idempotent under sequential re-runs (cursors +
 * `submitVerdict` dedup), so a sweep can fire as often as the debounce allows. The single-flight lock
 * keeps runs sequential; its steal path is best-effort (not a distributed mutex), so a rare double-run is
 * idempotency-bounded. See docs/design/maintenance-worker.md.
 */

const CONSOLIDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // recompute decay/prune at most every 6h
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
    // Atomic write (tmp+rename): a kill mid-`writeFileSync` would truncate the file → `loadSweepState`
    // resets to `{}` and every cursor + cadence stamp is lost (full re-reconcile, heavy jobs re-fire).
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      renameSync(tmp, file);
    } catch (e) {
      try {
        unlinkSync(tmp); // a failed rename (e.g. cross-device) leaves the tmp behind — clean it up
      } catch {
        /* already gone */
      }
      throw e;
    }
  } catch {
    /* best-effort */
  }
}

/** Acquire the single-flight lock (one sweep per data dir) via atomic `openSync(.., 'wx')`. A held lock
 *  is STOLEN when the holder is provably gone (`isPidAlive` dead) or older than `STALE_LOCK_MS`.
 *  Best-effort, NOT a distributed mutex: the steal's unlink→create has a tiny TOCTOU window, but the jobs
 *  tolerate a double-run (cursors + `submitVerdict` dedup), and the brain is guarded by Kùzu's own
 *  single-writer lock (surfaces as `RepoBusyError`, caught per-job). */
function acquireLock(lockFile: string, nowMs: number): boolean {
  const claim = (): boolean => {
    const fd = openSync(lockFile, 'wx'); // throws EEXIST if held
    try {
      writeFileSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return true;
  };
  const holderGone = (): boolean => {
    try {
      const pid = Number(readFileSync(lockFile, 'utf8').trim());
      if (!isPidAlive(pid)) return true; // the sweep that wrote this lock has crashed → steal now
    } catch {
      /* unreadable pid → fall through to the mtime check */
    }
    return nowMs - statSync(lockFile).mtimeMs > STALE_LOCK_MS;
  };
  try {
    mkdirSync(path.dirname(lockFile), { recursive: true });
    return claim();
  } catch {
    try {
      if (holderGone()) {
        unlinkSync(lockFile);
        return claim();
      }
    } catch {
      /* lost the steal race / vanished — treat as held */
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
    if (isDeadTarget(state.cursors[t.target])) continue; // closed PR — skip BEFORE the `gh` probe (no forever-reshell)
    const src = diffSourceFromTarget(t.target, t.baseRef);
    if (!src) continue;
    let head: string | undefined;
    try {
      head = src.source === 'pr' && src.pr != null ? await getPrHeadSha({ pr: src.pr, cwd }) : await getHeadSha(cwd);
    } catch {
      continue; // transient head-resolution failure → retry next sweep
    }
    if (!head) {
      // '' means a closed PR OR a transient gh failure — condemn to the dead sentinel only when `gh`
      // CONFIRMS CLOSED/MERGED (deadPrSentinel), so one outage can't disable a live PR's closure.
      if (src.source === 'pr' && src.pr != null) {
        let prState = '';
        try {
          prState = await getPrState({ pr: src.pr, cwd });
        } catch {
          /* treat as unknown → don't condemn */
        }
        if (deadPrSentinel(prState)) state.cursors[t.target] = CLOSED_TARGET;
      }
      continue;
    }
    if (!headAdvanced(state.cursors[t.target], head)) continue; // cursor no-op
    try {
      const r = await reconcileOutcomes(mainRepoPath, config, src);
      accepted += r.accepted;
      swept++;
      state.cursors[t.target] = head; // advance only on success (even if accepted 0 — head checked); head is truthy here
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
  // Index in an ISOLATED child (ADR-17), NEVER in-process — opening the code graph for a write in the
  // sweep process (which already opens the brain) SIGSEGVs Kùzu. No-ops in dev/tsx.
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

/**
 * Run the maintenance jobs against `main` (resolved from `repoPath`). Single-flight + best-effort: each
 * job is isolated in try/catch (one failing never blocks the next), and the whole run never throws.
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
