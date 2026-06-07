import path from 'node:path';
import type { ReviewerConfig } from '@plex/core';
import { findingAddressed } from '@plex/findings';
import { createEmbeddingProvider } from '@plex/knowledge';
import { getHeadSha, getPrHeadSha, getChangedFileTexts } from '@plex/ingest';
import { repoPaths } from './paths';
import type { DiffSource } from './diff';
import { reviewTarget } from './target';
import { Brain, type BrainFinding } from './brain';
import { submitVerdict } from './knowledge';

/**
 * Record an autonomous `accept` for each prior finding that one of `regionEmbeddings`
 * addressed (ADR-28). Shared by the review flow and standalone reconcile, using the
 * caller's open Brain handle so the per-repo Kùzu brain is opened once.
 */
export async function recordFixAccepts(
  repoPath: string,
  config: ReviewerConfig,
  target: string,
  brain: Brain,
  priorFindings: BrainFinding[],
  findingEmbeddings: number[][],
  regionEmbeddings: number[][],
): Promise<number> {
  let n = 0;
  for (let i = 0; i < priorFindings.length; i++) {
    const fv = findingEmbeddings[i];
    const f = priorFindings[i]!;
    if (fv && findingAddressed(fv, regionEmbeddings)) {
      await submitVerdict(repoPath, { findingId: f.id, kind: 'accept', file: f.file, line: f.line, title: f.title }, config, target, brain);
      await brain.markFindingOutcome(f.id, 'fixed');
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
 * The cheap, on-demand "did the author fix these?" check: embedded Kùzu brain + git +
 * embeddings, no service. Call it from the responder skill, a CI `on: push` step, or by
 * hand. A no-op without an embedding provider (needed to match) or when nothing moved.
 */
export async function reconcileOutcomes(
  repoPath: string,
  config: ReviewerConfig,
  src: DiffSource,
): Promise<ReconcileResult> {
  const repo = path.basename(path.resolve(repoPath));
  const target = reviewTarget(repo, src);
  const embedder = createEmbeddingProvider(config.embedding);
  if (!embedder) return { target, checked: 0, accepted: 0 };

  const cwd = repoPaths(repoPath, config.dataDir).repoPath;
  const brain = await Brain.open(repoPath, config);
  try {
    const state = await brain.loadRoundState(target);
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

    const accepted = await recordFixAccepts(repoPath, config, target, brain, state.priorFindings, findingEmb, regionEmb);
    return { target, checked: state.priorFindings.length, accepted };
  } finally {
    await brain.close();
  }
}
