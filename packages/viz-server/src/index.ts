export { startServer } from './server';
export type { ServeOptions, RunningServer } from './server';
export {
  DEFAULT_PORT,
  HOST,
  daemonFile,
  readDaemon,
  writeDaemon,
  clearDaemon,
  pidAlive,
  probe,
  liveDaemon,
  ensureDaemon,
} from './daemon';
export type { EnsureOptions } from './daemon';
export type { DaemonInfo } from './daemon';
export { listRepos, resolveRepo, reposRoot } from './registry';
export type { RepoEntry } from './registry';
export { collectCode, collectBrain, collectKnowledge, collectLineage, linkLineage, expandCodeFile } from './collect';
export { renderAppHtml } from './ui';
export type { GraphPayload, VizNode, VizEdge, GraphKind } from './model';
