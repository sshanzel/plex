import path from 'node:path';
import type { ReviewerConfig, ChangedRegion } from '@plex/core';
import { findingAddressedAt } from '@plex/findings';
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
  /** The changed regions aligned with `regionEmbeddings` — enables the file/line LOCALITY
   *  signal (ADR-28), which catches restructuring fixes that embeddings alone miss. Omit
   *  (default) to fall back to pure semantic matching. */
  changedRegions: ReadonlyArray<ChangedRegion> = [],
): Promise<number> {
  let n = 0;
  for (let i = 0; i < priorFindings.length; i++) {
    const f = priorFindings[i]!;
    if (findingAddressedAt({ file: f.file, line: f.line }, findingEmbeddings[i] ?? [], changedRegions, regionEmbeddings)) {
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
 * hand. Matches a finding to the pushed changes by EITHER a semantic title match OR
 * file/line LOCALITY (ADR-28) — the locality signal is what catches a restructuring fix
 * (try/catch wrap, moved lines) that reads nothing like the finding's title. A no-op without
 * an embedding provider (the semantic half needs it; locality still works) or when nothing moved.
 */
export async function reconcileOutcomes(
  repoPath: string,
  config: ReviewerConfig,
  src: DiffSource,
): Promise<ReconcileResult> {
  const repo = path.basename(path.resolve(repoPath));
  const target = reviewTarget(repo, src);
  // Embeddings power the SEMANTIC half only; the file/line LOCALITY half needs none (git +
  // anchors). So we no longer bail when no provider is configured (ADR-30 made embeddings
  // optional) — locality still reconciles restructuring fixes.
  const embedder = createEmbeddingProvider(config.embedding);

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

    // Embed only when a provider exists; otherwise empty vectors → semantic never fires and
    // recordFixAccepts decides purely on locality.
    let regionEmb: number[][] = changed.map(() => []);
    let findingEmb: number[][] = state.priorFindings.map(() => []);
    if (embedder) {
      const regionTexts = changed.map((c) => c.text);
      const findingTexts = state.priorFindings.map((f) => f.title);
      const vecs = await embedder.embed([...regionTexts, ...findingTexts]);
      regionEmb = changed.map((_, i) => vecs[i] ?? []);
      findingEmb = state.priorFindings.map((_, i) => vecs[regionTexts.length + i] ?? []);
    }

    const accepted = await recordFixAccepts(repoPath, config, target, brain, state.priorFindings, findingEmb, regionEmb, changed);
    return { target, checked: state.priorFindings.length, accepted };
  } finally {
    await brain.close();
  }
}
