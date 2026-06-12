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
export { recordIncident } from './incidents';
export { consolidatePitfalls } from './promotion';
export type { ConsolidateResult } from './promotion';
export { betaPosteriorMean, wilsonLowerBound, suppressionTier, Z_95, Z_68 } from './stats';
export type { SuppressionTier } from './stats';
