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
export { consolidatePitfalls, proposePromotions } from './promotion';
export type { ConsolidateResult, Promotions } from './promotion';
export { betaPosteriorMean, wilsonLowerBound } from './stats';
