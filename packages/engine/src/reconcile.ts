import { safeEmbed, type ReviewerConfig, type ChangedRegion } from '@plex/core';
import { findingAddressedAt } from '@plex/findings';
import { createEmbeddingProvider } from '@plex/knowledge';
import { getHeadSha, getPrHeadSha, getChangedFileTexts } from '@plex/ingest';
import { repoPaths } from './paths';
import type { DiffSource } from './diff';
import { reviewTargetFor } from './target';
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
    // `awareness` flags are never auto-accepted (ADR-31): an awareness item isn't a defect to be
    // "fixed" — its only valid outcomes are an EXPLICIT acknowledge (intentional) or reject. Auto-
    // inferring "fixed" from a nearby change is semantically wrong and, worse, pre-empts the
    // acknowledge → semantic-waiver path that keeps it quiet until it MATERIALLY changes.
    if (f.severity === 'awareness') continue;
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
  /**
   * Human-readable explanation of the outcome — so `accepted: 0` is never a black box. Names the
   * concrete cause (no open findings / no prior round recorded for this target / no commits since
   * the last review / N files changed but nothing matched / accepted M of N). The "no prior round"
   * case is the worktree split-brain tell (reviewTargetFor).
   */
  reason: string;
  /** The "since" window reconcile diffed: last reviewed round's head → current head. */
  fromSha?: string;
  toSha?: string;
  /** Files changed in that window. */
  changedFiles?: number;
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
  const target = reviewTargetFor(repoPath, src);
  // Embeddings power the SEMANTIC half only; the file/line LOCALITY half needs none (git +
  // anchors). So we no longer bail when no provider is configured (ADR-30 made embeddings
  // optional) — locality still reconciles restructuring fixes.
  const embedder = createEmbeddingProvider(config.embedding);

  const cwd = repoPaths(repoPath, config.dataDir).repoPath;
  const brain = await Brain.open(repoPath, config);
  try {
    // Self-heal a worktree brain split before reading state: if this review's rounds were
    // orphaned under a sibling target by an older build, adopt them so reconcile can proceed.
    const healed = await brain.healSplitTarget(target);
    const healNote = healed ? `merged ${healed.rounds} orphaned round(s) from "${healed.from}" (worktree brain split); ` : '';
    const state = await brain.loadRoundState(target);
    const checked = state.priorFindings.length;
    const head =
      src.source === 'pr' && src.pr != null ? await getPrHeadSha({ pr: src.pr, cwd }) : await getHeadSha(cwd);

    // Each early exit names WHY (so `accepted: 0` is diagnosable without log spelunking).
    if (checked === 0) return { target, checked, accepted: 0, reason: 'no open findings for this target — nothing to reconcile' };
    if (!state.lastHeadSha) {
      return {
        target,
        checked,
        accepted: 0,
        reason: `no prior round recorded for target "${target}" — cannot tell what changed since the findings were raised (if this repo is a worktree, the brain may be split across two target names; see reviewTargetFor)`,
      };
    }
    if (!head) return { target, checked, accepted: 0, reason: `${healNote}could not resolve the current head sha`, fromSha: state.lastHeadSha };
    if (state.lastHeadSha === head) {
      return { target, checked, accepted: 0, reason: `${healNote}no commits since the last reviewed round (head unchanged) — push fixes, then reconcile`, fromSha: state.lastHeadSha, toSha: head };
    }

    const changed = await getChangedFileTexts(cwd, state.lastHeadSha, head);
    if (changed.length === 0) {
      return { target, checked, accepted: 0, reason: `${healNote}commits exist since the last round but added no lines to diff against`, fromSha: state.lastHeadSha, toSha: head, changedFiles: 0 };
    }

    // Embed only when a provider exists; otherwise empty vectors → semantic never fires and
    // recordFixAccepts decides purely on locality.
    let regionEmb: number[][] = changed.map(() => []);
    let findingEmb: number[][] = state.priorFindings.map(() => []);
    if (embedder) {
      const regionTexts = changed.map((c) => c.text);
      const findingTexts = state.priorFindings.map((f) => f.title);
      // safeEmbed: cap + chunk (B-G1) and degrade to locality-only on a transient failure (m5)
      // instead of throwing out of the reconcile.
      const vecs = await safeEmbed(embedder, [...regionTexts, ...findingTexts]);
      if (vecs) {
        regionEmb = changed.map((_, i) => vecs[i] ?? []);
        findingEmb = state.priorFindings.map((_, i) => vecs[regionTexts.length + i] ?? []);
      }
    }

    const accepted = await recordFixAccepts(repoPath, config, target, brain, state.priorFindings, findingEmb, regionEmb, changed);
    const reason =
      accepted > 0
        ? `${healNote}accepted ${accepted} of ${checked} — a pushed change addressed them (semantic or file/line locality)`
        : `${healNote}${changed.length} file(s) changed since ${state.lastHeadSha.slice(0, 8)} but none matched an open finding (no semantic match and no change near a finding's file:line)${embedder ? '' : '; no embedding provider, so only locality was tried'}`;
    return { target, checked, accepted, reason, fromSha: state.lastHeadSha, toSha: head, changedFiles: changed.length };
  } finally {
    await brain.close();
  }
}
