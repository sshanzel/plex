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

/**
 * Merge the agent's submitted findings with deterministic findings, apply scoped
 * waivers, and rank/triage into one stream (ADR-03/04/05).
 */
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
  // Learned suppression (docs/design/negative-knowledge.md): accumulated dismissals demote/suppress
  // a rule by tag, weighted via Wilson — computed live so it needs no `consolidate` run.
  const suppressions = await loadSuppressions(config, repo);
  // Split suppressions: DETERMINISTIC (tag) are matched by tag in rankFindings; FIRST-PRINCIPLES
  // (embedding-keyed, ADR-41) are routed through the EXISTING semantic-waiver path as synthetic
  // `pattern-repo` waivers carrying the embedding — `waiverMatches` already does the cosine match, so
  // no new matching code lands in the pure package. Semantic suppressions act only at the `suppress`
  // tier (pattern-repo waivers are binary; a tagless semantic `demote` has nothing to explain it).
  // NOTE: a semantic suppression carries ONLY an embedding (no identity fallback — it *is* its
  // embedding). So if the per-review embed below fails (no provider / transient outage → findings
  // unembedded), its `waiverMatches` semantic branch is false and the suppression silently no-ops for
  // THIS review, reappearing next review once embeds recover. Deterministic suppression is unaffected
  // (off, not broken — the embeddings-optional posture, docs/design/negative-knowledge.md).
  const semanticSuppressions = suppressions.filter((d) => d.embedding && d.tier === 'suppress');
  const semanticWaivers: Waiver[] = semanticSuppressions.map((d) => ({ scope: 'pattern-repo', embedding: d.embedding }));
  const waiversAll = [...waivers, ...semanticWaivers];

  // Embed findings so semantic waivers (ADR-27) + first-principles suppressions can match the same
  // issue across rounds even after wording/line changes. Best-effort: only with a real provider.
  const all = [...agent, ...det];

  // Enrich each finding's `blast` from the sidecar the last get_review_context wrote (its file's
  // coupling centrality, or its neighbor score) — this makes the otherwise-dormant blast feature
  // live in the ranking, with NO Kùzu open here (the centrality was computed while the graph was
  // already open). Respects an agent-supplied value; best-effort (no sidecar ⇒ unchanged).
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
      // safeEmbed: a transient embedding failure degrades to identity-only waiver matching instead
      // of failing the whole review (m5); the batch is also capped + chunked (B-G1).
      const vecs = await safeEmbed(provider, all.map((f) => [f.title, f.body].filter(Boolean).join(' — ')));
      if (vecs) {
        all.forEach((f, i) => (f.embedding = vecs[i]));
        // Adapt UPWARD only (tuning.md §6): on an anisotropic model whose findings sit at a high
        // baseline cosine, raise the bar so a waiver suppresses more conservatively — never below
        // the hand-tuned floor, so it can't hide more than today's fixed value would.
        semanticThreshold = adaptiveFloor(WAIVER_SEMANTIC_THRESHOLD, cosineBackground(vecs));
      }
    }
  }
  // Only the DETERMINISTIC (tag) suppressions go in the tag map; semantic ones ride the waiver path above.
  const suppressionMap = new Map(suppressions.filter((d) => !d.embedding).map((d) => [d.key, d.tier] as const));
  const ranked = rankFindings(all, { waivers: waiversAll, semanticThreshold, suppressions: suppressionMap });
  // Record only the suppressions that ACTUALLY matched a finding this review (the ones that shaped
  // the output) as the audit-log provenance — not every active rule. Two paths: DETERMINISTIC ones
  // match by tag; FIRST-PRINCIPLES (embedding-keyed, ADR-41) ones have no tag, so `firedSemanticSuppressions`
  // attributes them via the same `waiverMatches` cosine the ranking used (else they'd silently vanish
  // from the trail). `all` still carries embeddings here (rankFindings strips them only from `ranked`).
  const appliedKeys = new Set(all.flatMap((f) => f.tags ?? []).filter((t) => suppressionMap.has(t)));
  const appliedSemantic = semanticThreshold == null ? [] : firedSemanticSuppressions(semanticSuppressions, all, semanticThreshold);
  const appliedSuppressions = [...suppressions.filter((d) => appliedKeys.has(d.key)), ...appliedSemantic];

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
