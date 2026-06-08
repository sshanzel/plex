export { repoPaths } from './paths';
export type { RepoPaths } from './paths';
export { loadConfig } from './config-load';
export { readHomeConfig, writeHomeConfig, homeConfigPath } from './home-config';
export type { HomeConfig } from './home-config';
export { resolveDiff } from './diff';
export type { DiffSource } from './diff';
export { resolveChangeContext } from './change-context';
export { reviewTarget, reviewTargetFor } from './target';
export { Brain } from './brain';
export type { RoundState, RoundSummary, BrainSignal, BrainFinding } from './brain';
export { logAudit, readAudit, auditFinding } from './audit';
export type { AuditEvent } from './audit';
export {
  indexRepo,
  assembleReviewContext,
  blastRadius,
} from './review';
export type { ReviewContext, AssembleOptions, GraphStaleness } from './review';
export { getDeterministicFindings, rankReviewFindings } from './findings';
export type { SubmittedFinding, RankReviewOptions } from './findings';
export { buildReviewPayload, postFindingsToPr } from './pr-comment';
export type { ReviewPayload } from './pr-comment';
export { reconcileOutcomes, recordFixAccepts } from './reconcile';
export type { ReconcileResult } from './reconcile';
export {
  knowledgeStore,
  buildKnowledgeQuery,
  getRelevantKnowledge,
  embeddingReady,
  seedKnowledge,
  learnIncident,
  submitVerdict,
  consolidateKnowledge,
  getPromotions,
} from './knowledge';
export { reviewContextToHtml } from './viz';
export {
  mineRepo,
  scanForMining,
  addMinedPitfalls,
  loadMiningState,
} from './mining';
export type {
  MineRepoOptions,
  MiningState,
  MiningCluster,
  ScanForMiningResult,
  AgentPitfall,
} from './mining';
export { recordVerdict, readVerdicts, loadWaivers } from './verdicts';
export type { StoredVerdict, VerdictInput, WaiverIdentity } from './verdicts';
