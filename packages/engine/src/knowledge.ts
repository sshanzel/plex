import type { ReviewerConfig, CodeLocation, Finding, IncidentOutcome } from '@plex/core';
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

/** Retrieve relevant pitfalls (ADR-01 grounded retrieval). */
export async function getRelevantKnowledge(
  config: ReviewerConfig,
  queryText: string,
  topK = 5,
): Promise<RetrievedPitfall[]> {
  if (!queryText.trim()) return [];
  const provider = createEmbeddingProvider(config.embedding);
  return retrieveRelevant(knowledgeStore(config), provider, queryText, topK);
}

/** Seed the knowledge base from markdown (cold start — ADR-09). */
export async function seedKnowledge(config: ReviewerConfig, md: string): Promise<number> {
  const provider = createEmbeddingProvider(config.embedding);
  return seedFromMarkdown(knowledgeStore(config), provider, md);
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
 * (the reviewer learns from confirmed findings — ADR-10). Used by both MCP and CLI.
 */
export async function submitVerdict(
  repoPath: string,
  input: VerdictInput,
  config: ReviewerConfig,
): Promise<StoredVerdict> {
  const stored = await recordVerdict(repoPath, input, config);
  if (input.kind === 'accept') {
    await learnIncident(config, {
      file: input.file,
      snippet: input.title,
      pitfallId: input.pattern,
      outcome: 'accepted',
    });
  }
  return stored;
}
