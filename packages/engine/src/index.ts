export { repoPaths } from './paths';
export type { RepoPaths } from './paths';
export { loadConfig } from './config-load';
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
export {
  knowledgeStore,
  buildKnowledgeQuery,
  getRelevantKnowledge,
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
