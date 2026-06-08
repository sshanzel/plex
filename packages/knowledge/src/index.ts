export {
  FakeEmbeddingProvider,
  OpenAIEmbeddingProvider,
  VoyageEmbeddingProvider,
  GeminiEmbeddingProvider,
  OllamaEmbeddingProvider,
  createEmbeddingProvider,
} from './embeddings';
export { KnowledgeStore } from './store';
export { retrieveRelevant } from './retrieve';
export type { RetrievedPitfall } from './retrieve';
export { parseMarkdownPitfalls, seedFromMarkdown, recordIncident } from './seed';
export type { ParsedPitfall } from './seed';
export { consolidatePitfalls, proposePromotions } from './promotion';
export type { ConsolidateResult, Promotions } from './promotion';
export { betaPosteriorMean, wilsonLowerBound } from './stats';
