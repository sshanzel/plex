export { rankFindings } from './rank';
export type { RankOptions } from './rank';
export { dedupeFindings, dedupeKey, normalizeTitle } from './dedupe';
export type { MergedFinding } from './dedupe';
export { computeSignal, severityWeight, defaultWeights } from './signal';
export type { SignalWeights } from './signal';
export { waiverMatches, isWaived } from './waivers';
export { classifyChanges } from './rounds';
export type { RegionVec, SignalVec, ClassifyOptions } from './rounds';
