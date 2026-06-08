import path from 'node:path';
import { safeEmbed, type ReviewerConfig, type CodeLocation, type Finding, type IncidentOutcome } from '@plex/core';
import {
  KnowledgeStore,
  createEmbeddingProvider,
  retrieveRelevant,
  seedFromMarkdown,
  recordIncident,
  consolidatePitfalls,
  proposePromotions,
  type RetrievedPitfall,
  type ConsolidateResult,
  type Promotions,
} from '@plex/knowledge';
import { recordVerdict, type VerdictInput, type StoredVerdict } from './verdicts';
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
 * Degrades gracefully: with no embedding provider configured, returns nothing (review
 * still runs on blast radius + deterministic checks).
 */
export async function getRelevantKnowledge(
  config: ReviewerConfig,
  queryText: string,
  topK = 5,
  repo?: string,
): Promise<RetrievedPitfall[]> {
  if (!queryText.trim()) return [];
  const provider = createEmbeddingProvider(config.embedding);
  if (!provider) return [];
  return retrieveRelevant(knowledgeStore(config), provider, queryText, topK, 0.05, repo);
}

/** Seed the knowledge base from markdown (cold start — ADR-09). */
export async function seedKnowledge(config: ReviewerConfig, md: string): Promise<number> {
  return seedFromMarkdown(knowledgeStore(config), requireEmbeddings(config), md);
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

/** Propose graph → markdown / → rule promotions (ADR-09). */
export async function getPromotions(
  config: ReviewerConfig,
  existingMarkdown = '',
): Promise<Promotions> {
  return proposePromotions(knowledgeStore(config), existingMarkdown);
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
  const stored = await recordVerdict(repoPath, enriched, config);
  if (input.kind === 'accept') {
    await learnIncident(config, {
      file: input.file,
      snippet: input.title,
      pitfallId: input.pattern,
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
