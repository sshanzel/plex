export { CodeGraphDB } from './db';
export { initSchema, DDL } from './schema';
export { buildCodeGraph, updateCodeGraph, FullRebuildRequired, GRAPH_VERSION } from './build';
export type { BuildOptions, BuildResult, UpdateResult, DeletedFileEdges } from './build';
export { extractFromSource, resolveRelativeImport, TS_EXTS } from './extract-ts';
export type { ExtractedFile, ExtractedSymbol } from './extract-ts';
export { tsPlugin, PLUGINS, pluginFor, isSupportedSource } from './languages';
export { aggregateCoChange, readCommits, headSha, changedSourceFilesSince, commitsBehind } from './co-change';
export type { CommitRecord, CoChangePair, AggregateOptions, ChangedFiles } from './co-change';
export {
  getSymbolsInFile,
  getCoChangeEdges,
  getCoChangeDegrees,
  getCouplingDegrees,
  getImportEdges,
  getRefEdges,
  getBarrelFiles,
  fileExists,
  getMeta,
} from './query';
export type { SymbolRow, CoChangeEdge } from './query';
export { resolvePreciseImports } from './precise';
export type { PreciseImportInput, PreciseEdge } from './precise';
