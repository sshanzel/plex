export {
  FakeEmbeddingProvider,
  OpenAIEmbeddingProvider,
  VoyageEmbeddingProvider,
  GeminiEmbeddingProvider,
  OllamaEmbeddingProvider,
  createEmbeddingProvider,
} from './embeddings';
export { KnowledgeStore } from './store';
export { retrieveRelevant, retrieveRelevantLexical, lexicalScores, lexicalTokens } from './retrieve';
export type { RetrievedPitfall } from './retrieve';
export { recordIncident, migrateIncidentAnchors } from './incidents';
export { buildKnowledgeGraph, historyOf, concernsAt, concernsInFile, pitfallsOf } from './graph';
export type { KnowledgeGraph } from './graph';
export { addOrReinforcePitfall } from './reinforce';
export type { AddOrReinforceResult } from './reinforce';
export { consolidatePitfalls } from './promotion';
export type { ConsolidateResult } from './promotion';
export { wilsonLowerBound, confidenceFromOutcomes, suppressionTier, recencyWeight, decayedCounts, CORROBORATED_WEIGHT, Z_95, Z_68 } from './stats';
export { recurrenceWeight } from './retrieve';
export type { SuppressionTier, DecayHalfLives, Dismissal } from './stats';
