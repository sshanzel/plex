import path from 'node:path';
import type { ReviewerConfig, Finding, RankedFinding, Severity, FindingSource } from '@plex/core';
import { runDeterministic } from '@plex/deterministic';
import { rankFindings } from '@plex/findings';
import { createEmbeddingProvider } from '@plex/knowledge';
import { resolveDiff, type DiffSource } from './diff';
import { loadWaivers } from './verdicts';
import { reviewTargetFor } from './target';
import { Brain, type BrainFinding } from './brain';
import { logAudit, auditFinding } from './audit';
import { postFindingsToPr } from './pr-comment';

/** Cosine ≥ this lets a pattern/category waiver suppress the same issue semantically (ADR-27). */
const WAIVER_SEMANTIC_THRESHOLD = 0.82;

/** A finding as submitted by the reviewing agent (flat shape for the MCP tool). */
export interface SubmittedFinding {
  title: string;
  body?: string;
  severity: Severity;
  confidence: number;
  source?: FindingSource;
  file: string;
  startLine: number;
  endLine?: number;
  symbol?: string;
  pitfallId?: string;
  tags?: string[];
  prevalence?: number;
  blastRadius?: number;
}

/** Deterministic (codified) findings for a diff. */
export async function getDeterministicFindings(
  repoPath: string,
  config: ReviewerConfig,
  src: DiffSource,
): Promise<Finding[]> {
  const diff = await resolveDiff(repoPath, config, src);
  return runDeterministic(repoPath, diff, { repoName: path.basename(path.resolve(repoPath)) });
}

export interface RankReviewOptions extends DiffSource {
  /** Merge deterministic findings into the stream (default true). */
  includeDeterministic?: boolean;
}

/**
 * Merge the agent's submitted findings with deterministic findings, apply scoped
 * waivers, and rank/triage into one stream (ADR-03/04/05).
 */
export async function rankReviewFindings(
  repoPath: string,
  config: ReviewerConfig,
  submitted: SubmittedFinding[],
  opts: RankReviewOptions = {},
): Promise<RankedFinding[]> {
  const repo = path.basename(path.resolve(repoPath));
  const agent: Finding[] = submitted.map((s, i) => ({
    id: `agent:${i}`,
    title: s.title,
    body: s.body ?? '',
    severity: s.severity,
    confidence: s.confidence,
    source: s.source ?? 'first-principles',
    location: { repo, file: s.file, startLine: s.startLine, endLine: s.endLine ?? s.startLine, symbol: s.symbol },
    pitfallId: s.pitfallId,
    tags: s.tags,
    prevalence: s.prevalence,
    blastRadius: s.blastRadius,
  }));

  const det = opts.includeDeterministic === false ? [] : await getDeterministicFindings(repoPath, config, opts);
  const waivers = await loadWaivers(repoPath, config);

  // Embed findings so semantic waivers (ADR-27) can suppress the same issue across rounds
  // even after wording/line changes. Best-effort: only when a real provider is configured
  // and there's at least one semantic (embedded) waiver to match against.
  const all = [...agent, ...det];
  let semanticThreshold: number | undefined;
  if (waivers.some((w) => w.embedding)) {
    const provider = createEmbeddingProvider(config.embedding);
    if (provider) {
      const vecs = await provider.embed(all.map((f) => [f.title, f.body].filter(Boolean).join(' — ')));
      all.forEach((f, i) => (f.embedding = vecs[i]));
      semanticThreshold = WAIVER_SEMANTIC_THRESHOLD;
    }
  }
  const ranked = rankFindings(all, { waivers, semanticThreshold });

  // Persist into the PR brain (round-tagged) + audit log (ADR-22/24/30). Key off the repo PATH
  // (basename), consistent with round recording + reconcile — never the graph meta (reviewTargetFor).
  const target = reviewTargetFor(repoPath, opts);
  let round = 1;
  let priorFindings: BrainFinding[] = [];
  const brain = await Brain.open(repoPath, config);
  try {
    const state = await brain.loadRoundState(target);
    round = state.lastN || 1;
    priorFindings = state.priorFindings; // captured BEFORE the write — i.e. earlier rounds only
    await brain.writeFindings(target, round, ranked);
  } finally {
    await brain.close();
  }

  // Auto-comment (ADR-34): when reviewing a PR and opted in, post the ranked stream as one
  // GitHub review — deduped against prior rounds. Best-effort: posting never breaks a review.
  if (config.autoComment && opts.source === 'pr' && opts.pr != null) {
    await postFindingsToPr(repoPath, config, opts.pr, ranked, priorFindings, round);
  }
  await logAudit(repoPath, config, {
    type: 'findings_submitted',
    repo,
    target,
    round,
    ts: new Date().toISOString(),
    findings: ranked.map(auditFinding),
  });

  return ranked;
}
