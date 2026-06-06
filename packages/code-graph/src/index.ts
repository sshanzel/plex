export { CodeGraphDB } from './db';
export { initSchema, DDL } from './schema';
export { buildCodeGraph } from './build';
export type { BuildOptions, BuildResult } from './build';
export {
  extractFromSource,
  resolveRelativeImport,
  isSupportedSource,
} from './extract-ts';
export type { ExtractedFile, ExtractedSymbol } from './extract-ts';
export { aggregateCoChange, readCommits, headSha } from './co-change';
export type { CommitRecord, CoChangePair, AggregateOptions } from './co-change';
export {
  getSymbolsInFile,
  getCoChangeEdges,
  getImportEdges,
  getRefEdges,
  fileExists,
  getMeta,
} from './query';
export type { SymbolRow, CoChangeEdge } from './query';
export { resolvePreciseImports } from './precise';
export type { PreciseImportInput, PreciseEdge } from './precise';
