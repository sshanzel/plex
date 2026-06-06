import path from 'node:path';
import type { ReviewerConfig, Finding, RankedFinding, Severity, FindingSource } from '@plex/core';
import { runDeterministic } from '@plex/deterministic';
import { rankFindings } from '@plex/findings';
import { resolveDiff, type DiffSource } from './diff';
import { loadWaivers } from './verdicts';

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
  return rankFindings([...agent, ...det], { waivers });
}
