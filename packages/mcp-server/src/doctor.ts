import type { ReviewerConfig } from '@plex/core';

export interface DoctorReport {
  version: string;
  node: string;
  pid: number;
  /** ISO build time of the code THIS process loaded. */
  loadedBuild: string;
  /** ISO build time of the code currently on disk. */
  onDiskBuild: string;
  /** True when a newer build is on disk than the running process loaded. */
  stale: boolean;
  advice: string;
  embeddings: string;
  knowledgeDir: string;
  dataDir: string;
}

/**
 * Pure health report. The point is `stale`: a long-lived stdio MCP process keeps running the
 * build it loaded at spawn, so a `pnpm build` (or package update) on disk has no effect until the
 * client reconnects/respawns. Comparing the loaded build time to the file's current mtime makes
 * that visible instead of silent (which is exactly what bit us — a fix that "didn't apply").
 */
export function buildDoctorReport(args: {
  version: string;
  config: ReviewerConfig;
  loadedBuildMs: number;
  onDiskBuildMs: number;
  node: string;
  pid: number;
}): DoctorReport {
  const { version, config, loadedBuildMs, onDiskBuildMs, node, pid } = args;
  const stale = onDiskBuildMs > loadedBuildMs + 1; // +1ms guards against mtime float jitter
  const iso = (ms: number): string => (ms > 0 ? new Date(ms).toISOString() : 'unknown');
  return {
    version,
    node,
    pid,
    loadedBuild: iso(loadedBuildMs),
    onDiskBuild: iso(onDiskBuildMs),
    stale,
    advice: stale
      ? 'A NEWER build is on disk than this process loaded — reconnect Plex (/mcp → reconnect plex, or restart the session) so a fresh process picks it up. A long-lived stdio server keeps running its loaded build until then.'
      : 'Up to date — running the latest build on disk.',
    embeddings: config.embedding.provider,
    knowledgeDir: config.knowledgeDir,
    dataDir: config.dataDir || '(centralized: ~/.plex/repos/<id>)',
  };
}
