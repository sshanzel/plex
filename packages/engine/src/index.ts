export { repoPaths } from './paths';
export type { RepoPaths } from './paths';
export { loadConfig } from './config-load';
export { readHomeConfig, writeHomeConfig, homeConfigPath } from './home-config';
export type { HomeConfig } from './home-config';
export { dockerAvailable, falkorUp, falkorDown, falkorReachable, FALKOR_IMAGE } from './setup';
export type { FalkorUpResult } from './setup';
export { resolveDiff } from './diff';
export type { DiffSource } from './diff';
export { resolveChangeContext } from './change-context';
export { reviewTarget } from './target';
export {
  brainEnabled,
  loadRoundState,
  recordRound,
  writeFindings,
  writeVerdict,
} from './brain';
export type { RoundState, RoundSummary, BrainSignal } from './brain';
export { logAudit, readAudit, auditFinding } from './audit';
export type { AuditEvent } from './audit';
export {
  indexRepo,
  assembleReviewContext,
  blastRadius,
} from './review';
export type { ReviewContext, AssembleOptions, GraphStaleness } from './review';
export { installHooks, uninstallHooks } from './hooks';
export type { HookResult } from './hooks';
export { getDeterministicFindings, rankReviewFindings } from './findings';
export type { SubmittedFinding, RankReviewOptions } from './findings';
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
