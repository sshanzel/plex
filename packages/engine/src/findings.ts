import path from 'node:path';
import { readFileSync } from 'node:fs';
import { safeEmbed, cosineBackground, adaptiveFloor, type ReviewerConfig, type Finding, type RankedFinding, type Severity, type FindingSource, type Waiver } from '@plex/core';
import { repoPaths } from './paths';
import { runDeterministic } from '@plex/deterministic';
import { rankFindings, firedSemanticSuppressions } from '@plex/findings';
import { createEmbeddingProvider } from '@plex/knowledge';
import { resolveDiff, type DiffSource } from './diff';
import { loadWaivers } from './verdicts';
import { loadSuppressions } from './knowledge';
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

/** Merge agent + deterministic findings, apply scoped waivers, and rank/triage into one stream (ADR-03/04/05). */
export async function rankReviewFindings(
  repoPath: string,
  config: ReviewerConfig,
  submitted: SubmittedFinding[],
  opts: RankReviewOptions = {},
): Promise<{ ranked: RankedFinding[]; autoComment?: { posted: number } | { error: string } }> {
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
  // Learned suppression (docs/design/negative-knowledge.md): dismissals demote/suppress a rule by tag,
  // Wilson-weighted, computed live (no `consolidate` needed).
  const suppressions = await loadSuppressions(config, repo);
  // Split suppressions: DETERMINISTIC (tag) matched by tag in rankFindings; FIRST-PRINCIPLES
  // (embedding-keyed, ADR-41) routed through the EXISTING semantic-waiver path as synthetic
  // `pattern-repo` waivers (only at the `suppress` tier). NOTE: a semantic suppression IS its embedding
  // (no identity fallback), so if the per-review embed below fails it silently no-ops for THIS review and
  // reappears once embeds recover; deterministic suppression is unaffected (embeddings-optional posture).
  const semanticSuppressions = suppressions.filter((d) => d.embedding && d.tier === 'suppress');
  const semanticWaivers: Waiver[] = semanticSuppressions.map((d) => ({ scope: 'pattern-repo', embedding: d.embedding }));
  const waiversAll = [...waivers, ...semanticWaivers];

  // Embedded below so semantic waivers (ADR-27) + first-principles suppressions match the same issue
  // across rounds even after wording/line changes. Best-effort: only with a real provider.
  const all = [...agent, ...det];

  // Enrich each finding's `blast` from the sidecar the last get_review_context wrote — making the
  // blast feature live in the ranking with NO Kùzu open here. Respects an agent value; best-effort.
  try {
    const mapFile = path.join(repoPaths(repoPath, config.dataDir).reviewerDir, 'blast-map.json');
    const sidecar = JSON.parse(readFileSync(mapFile, 'utf8')) as { target?: string; files?: Record<string, number> };
    if (sidecar.files && sidecar.target === reviewTargetFor(repoPath, opts)) {
      for (const f of all) {
        const s = sidecar.files[f.location.file];
        if (f.blastRadius == null && s != null) f.blastRadius = s;
      }
    }
  } catch {
    /* no sidecar / parse error → blast stays as submitted (best-effort) */
  }

  let semanticThreshold: number | undefined;
  if (waiversAll.some((w) => w.embedding)) {
    const provider = createEmbeddingProvider(config.embedding);
    if (provider) {
      // safeEmbed: a transient failure degrades to identity-only waiver matching (m5); capped + chunked (B-G1).
      const vecs = await safeEmbed(provider, all.map((f) => [f.title, f.body].filter(Boolean).join(' — ')));
      if (vecs) {
        all.forEach((f, i) => (f.embedding = vecs[i]));
        // Adapt UPWARD only (tuning.md §6) — never below the hand-tuned floor, so a waiver can't hide
        // more than today's fixed value would.
        semanticThreshold = adaptiveFloor(WAIVER_SEMANTIC_THRESHOLD, cosineBackground(vecs));
      }
    }
  }
  // Only DETERMINISTIC (tag) suppressions go in the tag map; semantic ones ride the waiver path above.
  // Each carries its location scope (ADR-48) so the ranker suppresses a symbol-scoped rule only at the
  // symbols it was dismissed at.
  const suppressionMap = new Map(
    suppressions.filter((d) => !d.embedding).map((d) => [d.key, { tier: d.tier, repoWide: d.repoWide, symbols: d.symbols }] as const),
  );
  const ranked = rankFindings(all, { waivers: waiversAll, semanticThreshold, suppressions: suppressionMap });
  // Audit-log provenance: only the suppressions that ACTUALLY matched a finding this review. Tag ones
  // by tag; first-principles ones (no tag, ADR-41) attributed by `firedSemanticSuppressions` via the
  // same cosine the ranking used. `all` still carries embeddings (rankFindings strips only `ranked`).
  const appliedKeys = new Set(all.flatMap((f) => f.tags ?? []).filter((t) => suppressionMap.has(t)));
  const appliedSemantic = semanticThreshold == null ? [] : firedSemanticSuppressions(semanticSuppressions, all, semanticThreshold);
  const appliedSuppressions = [...suppressions.filter((d) => appliedKeys.has(d.key)), ...appliedSemantic];

  // Persist into the PR brain + audit log (ADR-22/24/30). Key off the BASE repo (reviewTargetFor),
  // consistent with round recording + reconcile — never the graph meta.
  const target = reviewTargetFor(repoPath, opts);
  let round = 1;
  let priorFindings: BrainFinding[] = [];
  const brain = await Brain.open(repoPath, config);
  try {
    const state = await brain.loadRoundState(target);
    round = state.lastN || 1;
    priorFindings = state.priorFindings; // captured BEFORE the write — earlier rounds only
    await brain.writeFindings(target, round, ranked);
  } finally {
    await brain.close();
  }

  // Auto-comment (ADR-34): post the ranked stream as one GitHub review, deduped against prior rounds.
  // Best-effort: posting never breaks a review.
  let autoComment: { posted: number } | { error: string } | undefined;
  if (config.autoComment && opts.source === 'pr' && opts.pr != null) {
    autoComment = await postFindingsToPr(repoPath, config, opts.pr, ranked, priorFindings, round);
  }
  await logAudit(repoPath, config, {
    type: 'findings_submitted',
    repo,
    target,
    round,
    ts: new Date().toISOString(),
    findings: ranked.map(auditFinding),
    ...(appliedSuppressions.length
      ? { suppressions: appliedSuppressions.map((d) => ({ key: d.key, tier: d.tier, dismissals: d.dismissals, corrections: d.corrections })) }
      : {}),
  });

  return { ranked, ...(autoComment !== undefined ? { autoComment } : {}) };
}
