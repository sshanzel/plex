import path from 'node:path';
import type { ReviewerConfig } from '@plex/core';
import { findingAddressed } from '@plex/findings';
import { getHeadSha, getPrHeadSha, getChangedFileTexts } from '@plex/ingest';
import { repoPaths } from './paths';
import type { DiffSource } from './diff';
import { reviewTarget } from './target';
import { brainEnabled, loadRoundState, markFindingOutcome, type BrainFinding } from './brain';
import { requireEmbeddings, submitVerdict } from './knowledge';

/**
 * Record an autonomous `accept` for each prior finding that one of `regionEmbeddings`
 * addressed (ADR-28). Shared by the review flow and standalone reconcile so the logic
 * lives in one place. Returns how many were accepted.
 */
export async function recordFixAccepts(
  repoPath: string,
  config: ReviewerConfig,
  target: string,
  priorFindings: BrainFinding[],
  findingEmbeddings: number[][],
  regionEmbeddings: number[][],
): Promise<number> {
  let n = 0;
  for (let i = 0; i < priorFindings.length; i++) {
    const fv = findingEmbeddings[i];
    const f = priorFindings[i]!;
    if (fv && findingAddressed(fv, regionEmbeddings)) {
      await submitVerdict(repoPath, { findingId: f.id, kind: 'accept', file: f.file, line: f.line, title: f.title }, config, target);
      await markFindingOutcome(target, f.id, 'fixed', config);
      n++;
    }
  }
  return n;
}

export interface ReconcileResult {
  target: string;
  /** Open findings examined. */
  checked: number;
  /** Findings auto-accepted because a pushed change addressed them. */
  accepted: number;
}

/**
 * Reconcile a target's open findings against what has been pushed since they were raised,
 * recording `accept` for the ones now addressed (ADR-28) — WITHOUT running a full review.
 *
 * This is the cheap, on-demand "did the author fix these?" check: Kùzu-free (FalkorDB + git
 * + embeddings only), so it's safe to call from the responder skill, a CI `on: push` step,
 * or by hand — instead of putting heavy work in a `pre-push` git hook. A no-op when the
 * brain is disabled or nothing has moved since the last round.
 */
export async function reconcileOutcomes(
  repoPath: string,
  config: ReviewerConfig,
  src: DiffSource,
): Promise<ReconcileResult> {
  const repo = path.basename(path.resolve(repoPath));
  const target = reviewTarget(repo, src);
  if (!brainEnabled(config)) return { target, checked: 0, accepted: 0 };

  const embedder = requireEmbeddings(config);
  const cwd = repoPaths(repoPath, config.dataDir).repoPath;
  const state = await loadRoundState(target, config); // requireFalkor

  const head =
    src.source === 'pr' && src.pr != null ? await getPrHeadSha({ pr: src.pr, cwd }) : await getHeadSha(cwd);
  if (state.priorFindings.length === 0 || !state.lastHeadSha || !head || state.lastHeadSha === head) {
    return { target, checked: state.priorFindings.length, accepted: 0 };
  }

  const changed = await getChangedFileTexts(cwd, state.lastHeadSha, head);
  if (changed.length === 0) return { target, checked: state.priorFindings.length, accepted: 0 };

  const regionTexts = changed.map((c) => c.text);
  const findingTexts = state.priorFindings.map((f) => f.title);
  const vecs = await embedder.embed([...regionTexts, ...findingTexts]);
  const regionEmb = changed.map((_, i) => vecs[i] ?? []);
  const findingEmb = state.priorFindings.map((_, i) => vecs[regionTexts.length + i] ?? []);

  const accepted = await recordFixAccepts(repoPath, config, target, state.priorFindings, findingEmb, regionEmb);
  return { target, checked: state.priorFindings.length, accepted };
}
