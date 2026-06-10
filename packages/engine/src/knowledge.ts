import path from 'node:path';
import {
  safeEmbed,
  cosineSimilarity,
  cosineBackground,
  adaptiveFloor,
  type ReviewerConfig,
  type CodeLocation,
  type Finding,
  type IncidentOutcome,
} from '@plex/core';
import {
  KnowledgeStore,
  createEmbeddingProvider,
  retrieveRelevant,
  retrieveRelevantLexical,
  lexicalScores,
  recordIncident,
  consolidatePitfalls,
  proposePromotions,
  type RetrievedPitfall,
  type ConsolidateResult,
  type Promotions,
} from '@plex/knowledge';
import { recordVerdict, readVerdicts, type VerdictInput, type StoredVerdict } from './verdicts';
import { Brain } from './brain';
import { logAudit } from './audit';

export function knowledgeStore(config: ReviewerConfig): KnowledgeStore {
  return new KnowledgeStore(config.knowledgeDir);
}

/** Build the retrieval query from what the diff touches + the deterministic findings. */
export function buildKnowledgeQuery(
  changed: CodeLocation[],
  deterministic: Finding[],
  files: string[],
): string {
  return [...changed.map((c) => c.symbol ?? c.file), ...deterministic.map((d) => d.title), ...files]
    .join(' ')
    .slice(0, 2000);
}

const NO_EMBEDDINGS =
  "No embedding provider — set PLEX_EMBEDDING_PROVIDER (voyage | openai | gemini | ollama) and its API key. ('fake' is test-only.)";

/** Embedding provider or throw — for write paths that must not store noise. */
export function requireEmbeddings(config: ReviewerConfig) {
  const p = createEmbeddingProvider(config.embedding);
  if (!p) throw new Error(NO_EMBEDDINGS);
  return p;
}

/** Is a real embedding provider (with its key) configured? — for `plex doctor`. */
export function embeddingReady(config: ReviewerConfig): boolean {
  return config.embedding.provider !== 'fake' && createEmbeddingProvider(config.embedding) != null;
}

/**
 * Retrieve relevant pitfalls (ADR-01 grounded retrieval), scoped to `repo` (ADR-21).
 * Degrades gracefully: with no embedding provider configured, falls back to lexical
 * (IDF-weighted token overlap) retrieval — weaker ranking, but a key-less install still
 * gets its mined/accumulated pitfalls back instead of nothing.
 */
export async function getRelevantKnowledge(
  config: ReviewerConfig,
  queryText: string,
  topK = 5,
  repo?: string,
): Promise<RetrievedPitfall[]> {
  if (!queryText.trim()) return [];
  const store = knowledgeStore(config);
  const provider = createEmbeddingProvider(config.embedding);
  if (!provider) return retrieveRelevantLexical(store, queryText, topK, 0.05, repo);
  return retrieveRelevant(store, provider, queryText, topK, 0.05, repo);
}

// Floors for retroactively linking an accepted finding to a pitfall. Conservative on purpose:
// a wrong link feeds one pitfall's confidence with another issue's evidence, which is worse
// than learning nothing. The embed floor adapts UPWARD on anisotropic models (tuning.md §6);
// lexical scores run lower than cosine, hence the lower bar.
const INFER_EMBED_FLOOR = 0.7;
const INFER_LEXICAL_FLOOR = 0.45;

/**
 * Best-effort: find the pitfall an accepted finding instantiates, so the accept reinforces it
 * (ADR-10). Most agent findings are first-principles and carry no pitfallId — without this, an
 * explicit "this is a real issue" verdict taught the knowledge base nothing. Embedding cosine
 * where vectors exist; lexical IDF overlap for vectorless pitfalls (and key-less installs).
 * Returns undefined on any failure — inference is enrichment, never a verdict blocker.
 */
export async function inferPitfallId(
  config: ReviewerConfig,
  title: string | undefined,
  repo?: string,
): Promise<string | undefined> {
  if (!title?.trim()) return undefined;
  try {
    const pitfalls = (await knowledgeStore(config).pitfalls()).filter(
      (p) => (p.scope ?? 'global') !== 'repo' || p.repo === repo,
    );
    if (pitfalls.length === 0) return undefined;
    const embedded = pitfalls.filter((p) => p.embedding && p.embedding.length > 0);
    const provider = createEmbeddingProvider(config.embedding);
    let judgedSemantically = false;
    if (provider && embedded.length > 0) {
      const q = (await safeEmbed(provider, [title]))?.[0];
      if (q) {
        judgedSemantically = true;
        const floor = adaptiveFloor(INFER_EMBED_FLOOR, cosineBackground(embedded.map((p) => p.embedding!)));
        let best: { id: string; score: number } | undefined;
        for (const p of embedded) {
          const score = cosineSimilarity(q, p.embedding!);
          if (score >= floor && (best == null || score > best.score)) best = { id: p.id, score };
        }
        if (best) return best.id;
      }
    }
    // Lexical pass over what the semantic pass could NOT judge (vectorless pitfalls; everything
    // when no provider) — never second-guess a semantic "not similar" with a keyword match.
    const candidates = judgedSemantically ? pitfalls.filter((p) => !p.embedding || p.embedding.length === 0) : pitfalls;
    if (candidates.length === 0) return undefined;
    const lex = lexicalScores(title, candidates);
    let bi = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (lex[i]! >= INFER_LEXICAL_FLOOR && (bi < 0 || lex[i]! > lex[bi]!)) bi = i;
    }
    return bi >= 0 ? candidates[bi]!.id : undefined;
  } catch {
    return undefined;
  }
}

/** Record a confirmed finding as an incident (feedback loop — ADR-10). */
export async function learnIncident(
  config: ReviewerConfig,
  input: { repo?: string; file?: string; snippet?: string; outcome?: IncidentOutcome; pitfallId?: string },
): Promise<string> {
  return recordIncident(knowledgeStore(config), {
    ...input,
    source: 'review',
    ts: new Date().toISOString(),
  });
}

/** Recompute pitfall confidence from incident outcomes (feedback loop — ADR-10). */
export async function consolidateKnowledge(config: ReviewerConfig): Promise<ConsolidateResult> {
  return consolidatePitfalls(knowledgeStore(config));
}

/** Propose graph → deterministic-rule (ast-grep) promotions for codifiable pitfalls. */
export async function getPromotions(config: ReviewerConfig): Promise<Promotions> {
  return proposePromotions(knowledgeStore(config));
}

/**
 * Record a verdict and close the feedback loop: an `accept` becomes a knowledge incident
 * (the reviewer learns from confirmed findings — ADR-10), and the verdict is projected
 * into the PR brain + audit log (ADR-22/24). `target` (from the caller's diff source)
 * keys which PR graph the verdict lands in. Used by both MCP and CLI.
 */
export async function submitVerdict(
  repoPath: string,
  input: VerdictInput,
  config: ReviewerConfig,
  target?: string,
  sharedBrain?: Brain,
): Promise<StoredVerdict> {
  // For waivers AND acknowledgments, embed the finding's title so it can be re-matched
  // semantically next round (ADR-27/31) — best-effort: only when a real provider is configured.
  let enriched = input;
  if ((input.kind === 'waive' || input.kind === 'acknowledge') && input.embedding == null) {
    const text = [input.title, input.note].filter(Boolean).join(' — ').trim();
    if (text) {
      const provider = createEmbeddingProvider(config.embedding);
      if (provider) {
        // safeEmbed: a transient embedding failure stores the waiver WITHOUT a vector (it still
        // suppresses by identity; only semantic re-matching is lost) rather than failing the verdict.
        const vecs = await safeEmbed(provider, [text]);
        if (vecs?.[0]) enriched = { ...input, embedding: vecs[0] };
      }
    }
  }
  // Learning-side idempotency: a re-accept of an already-accepted finding (an agent retry, or
  // reconcile re-matching a finding someone record_outcome'd by hand) must NOT create a second
  // incident — duplicated evidence inflates the pitfall's Beta posterior. Checked BEFORE the
  // append below so the new verdict can't match itself; the verdict line itself is still
  // recorded (the log is append-only bookkeeping).
  const alreadyAccepted =
    input.kind === 'accept' &&
    input.findingId != null &&
    (await readVerdicts(repoPath, config)).some((v) => v.kind === 'accept' && v.findingId === input.findingId);
  const stored = await recordVerdict(repoPath, enriched, config);
  if (input.kind === 'accept' && !alreadyAccepted) {
    const repoName = path.basename(path.resolve(repoPath));
    // Link the accept to the pitfall it confirms: explicit `pattern` wins, else infer by
    // similarity — so first-principles accepts (the common case) reinforce knowledge too.
    // EXCEPT for inferred (auto) accepts: a locality fix-match feeding a title-similarity
    // pitfall match would stack two inferences into the Beta posterior — a false locality
    // accept silently inflating a pitfall is worse than learning nothing. Inferred accepts
    // still record their incident (provenance), but only an explicit `pattern` links them.
    const pitfallId = input.pattern ?? (input.inferred ? undefined : await inferPitfallId(config, input.title, repoName));
    await learnIncident(config, {
      repo: repoName,
      file: input.file,
      snippet: input.title,
      pitfallId,
      outcome: 'accepted',
    });
  }

  if (target) {
    const brain = sharedBrain ?? (await Brain.open(repoPath, config));
    let round = 1;
    try {
      round = (await brain.loadRoundState(target)).lastN || 1;
      await brain.writeVerdict(target, {
        findingId: input.findingId, kind: input.kind, scope: input.scope,
        title: input.title, file: input.file, line: input.line, ts: stored.ts,
      });
      // Project the disposition onto the brain Finding so it leaves `priorFindings`: an
      // explicitly dispositioned finding must not be re-matched by later fix inference
      // (reconcile / the next review), which would re-accept it and learn the same evidence
      // twice. recordFixAccepts overwrites accept→'fixed' right after — same family, finer term.
      const outcomeByKind: Record<string, string> = {
        accept: 'accepted', reject: 'rejected', waive: 'waived', acknowledge: 'acknowledged',
      };
      const projected = outcomeByKind[input.kind];
      if (projected) await brain.markFindingOutcome(input.findingId, projected);
    } finally {
      if (!sharedBrain) await brain.close();
    }
    await logAudit(repoPath, config, {
      type: 'outcome_recorded',
      repo: path.basename(path.resolve(repoPath)),
      target,
      round,
      ts: stored.ts,
      findingId: input.findingId,
      kind: input.kind,
      scope: input.scope,
    });
  }
  return stored;
}
