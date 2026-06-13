export { normalizeUnifiedDiff, groupRanges, addedTextByFile } from './normalize';
export type { ChangedFileText } from './normalize';
export { getLocalDiff, getCommitSubjects, getHeadSha, getChangedFileTexts, isTransientSpawnError } from './local';
export type { LocalDiffMode, LocalDiffOptions } from './local';
export { getPrDiff, getPrMeta, getPrHeadSha, getPrState, postPrReview } from './github';
export type { PrDiffOptions, PrMeta, PrReviewComment } from './github';
