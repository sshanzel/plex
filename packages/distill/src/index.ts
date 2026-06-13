export type { RawComment, DistillResult } from './types';
export { listPrs, fetchCommentsForPr, groupThreads } from './github';
export type { PrRef } from './github';
export { isSubstantive, categorize } from './classify';
export { outcomeFor } from './outcome';
export { isOutdated } from './github';
export { greedyCluster, centroid, adaptiveCosineThreshold } from './cluster';
export { llmDistill, distilledPitfallId } from './distill';
export type { ClusterInput } from './distill';
export {
  ClaudeCliCompletionProvider,
  AnthropicCompletionProvider,
  OpenAICompletionProvider,
  createCompletionProvider,
} from './llm';
export { distillHistory, scanHistory } from './pipeline';
export type { DistillOptions, DistillOutcome, ScanResult } from './pipeline';
