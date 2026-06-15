import { safeEmbed, cosineBackground, adaptiveFloor, type ReviewerConfig, type ChangedRegion } from '@plex/core';
import { findingAddressMatch } from '@plex/findings';
import { createEmbeddingProvider } from '@plex/knowledge';
import { getHeadSha, getPrHeadSha, getChangedFileTexts } from '@plex/ingest';
import { repoPaths } from './paths';
import type { DiffSource } from './diff';
import { reviewTargetFor } from './target';
import { Brain, type BrainFinding } from './brain';
import { submitVerdict } from './knowledge';

/** One auto-accepted finding, with the signal that matched it — the audit trail that keeps
 *  locality auto-accepts honest (a false accept is visible, not a silent disappearance). */
export interface AcceptedFix {
  findingId: string;
  title: string;
  file?: string;
  line?: number;
  matchedBy: 'semantic' | 'locality';
}

/**
 * Record an autonomous `accept` for each prior finding that one of `regionEmbeddings`
 * addressed (ADR-28), returning WHAT was accepted and HOW it matched. Shared by the review
 * flow and standalone reconcile, using the caller's open Brain handle so the per-repo Kùzu
 * brain is opened once.
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
): Promise<AcceptedFix[]> {
  // Adapt the semantic auto-accept cut UPWARD only (tuning.md §6): on an anisotropic model the
  // bar rises so a "fix" must be more clearly related before we auto-accept — never below the 0.6
  // floor, so it never auto-accepts (and thus silences) more than today's fixed value would. With
  // no embedder the embeddings are empty → background {0,0} → stays 0.6, and locality still works.
  const semanticThreshold = adaptiveFloor(0.6, cosineBackground([...regionEmbeddings, ...findingEmbeddings]));
  const accepts: AcceptedFix[] = [];
  for (let i = 0; i < priorFindings.length; i++) {
    const f = priorFindings[i]!;
    // `awareness` flags are never auto-accepted (ADR-31): an awareness item isn't a defect to be
    // "fixed" — its only valid outcomes are an EXPLICIT acknowledge (intentional) or reject. Auto-
    // inferring "fixed" from a nearby change is semantically wrong and, worse, pre-empts the
    // acknowledge → semantic-waiver path that keeps it quiet until it MATERIALLY changes.
    if (f.severity === 'awareness') continue;
    const matchedBy = findingAddressMatch({ file: f.file, line: f.line }, findingEmbeddings[i] ?? [], changedRegions, regionEmbeddings, { semanticThreshold });
    if (matchedBy) {
      // Pass the rule tag as `pattern` so an inferred accept can REFUTE a learned suppression
      // (ADR-39): the brain id can't carry it, so without this a fix never pulls the tier back down.
      await submitVerdict(repoPath, { findingId: f.id, kind: 'accept', inferred: true, file: f.file, line: f.line, title: f.title, pattern: f.rule || undefined }, config, target, brain);
      await brain.markFindingOutcome(f.id, 'fixed');
      accepts.push({ findingId: f.id, title: f.title, file: f.file, line: f.line, matchedBy });
    }
  }
  return accepts;
}

export interface ReconcileResult {
  target: string;
  /** Open findings checked. */
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
  /** What was auto-accepted and which signal matched it (the audit trail; present when accepted > 0). */
  acceptedFindings?: AcceptedFix[];
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
    // Lineage is base-keyed + durable (ADR-46): a worktree and its base share one target, so there's
    // no brain split to heal, and a worktree's prior rounds survive `git worktree remove`.
    const state = await brain.loadRoundState(target);
    const checked = state.priorFindings.length;
    const head =
      src.source === 'pr' && src.pr != null ? await getPrHeadSha({ pr: src.pr, cwd }) : await getHeadSha(cwd);

    if (checked === 0) return { target, checked, accepted: 0, reason: 'no open findings for this target — nothing to reconcile' };
    if (!state.lastHeadSha) {
      return {
        target,
        checked,
        accepted: 0,
        reason: `no prior round recorded for target "${target}" — cannot tell what changed since the findings were raised`,
      };
    }
    if (!head) return { target, checked, accepted: 0, reason: 'could not resolve the current head sha', fromSha: state.lastHeadSha };
    if (state.lastHeadSha === head) {
      return { target, checked, accepted: 0, reason: 'no commits since the last reviewed round (head unchanged) — push fixes, then reconcile', fromSha: state.lastHeadSha, toSha: head };
    }

    const changed = await getChangedFileTexts(cwd, state.lastHeadSha, head);
    if (changed.length === 0) {
      return { target, checked, accepted: 0, reason: 'commits exist since the last round but added no lines to diff against', fromSha: state.lastHeadSha, toSha: head, changedFiles: 0 };
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

    const accepts = await recordFixAccepts(repoPath, config, target, brain, state.priorFindings, findingEmb, regionEmb, changed);
    const accepted = accepts.length;
    const reason =
      accepted > 0
        ? `accepted ${accepted} of ${checked} — a pushed change addressed them (see acceptedFindings for what matched and how)`
        : `${changed.length} file(s) changed since ${state.lastHeadSha.slice(0, 8)} but none matched an open finding (no semantic match and no change near a finding's file:line)${embedder ? '' : '; no embedding provider, so only locality was tried'}`;
    return { target, checked, accepted, reason, fromSha: state.lastHeadSha, toSha: head, changedFiles: changed.length, ...(accepted > 0 ? { acceptedFindings: accepts } : {}) };
  } finally {
    await brain.close();
  }
}
