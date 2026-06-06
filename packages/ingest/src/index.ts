export { normalizeUnifiedDiff, groupRanges, addedTextByFile } from './normalize';
export type { ChangedFileText } from './normalize';
export { getLocalDiff, getCommitSubjects, getHeadSha, getChangedFileTexts } from './local';
export type { LocalDiffMode, LocalDiffOptions } from './local';
export { getPrDiff, getPrMeta, getPrHeadSha } from './github';
export type { PrDiffOptions, PrMeta } from './github';
