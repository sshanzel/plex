import path from 'node:path';
import os from 'node:os';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { ReviewerConfig } from '@plex/core';

export interface OrphanedRepo {
  dir: string;
  /** The repoPath recorded at index time — no longer exists on disk. */
  repoPath: string;
  /** Total size of the data dir in bytes (best-effort). */
  sizeBytes: number;
}

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
  /** Configured embedding provider name (e.g. `voyage`, `none`). */
  embeddings: string;
  /**
   * Whether that provider will ACTUALLY fire — i.e. resolves to a usable client (key present).
   * A configured `voyage` with no `VOYAGE_API_KEY` / `config.apiKey` reports `embeddings: 'voyage'`
   * but `embeddingsActive: false`: it silently degrades to lexical, so nothing reaches the provider
   * (the "my dashboard shows no usage" tell). `false` for the test-only `fake` provider too.
   */
  embeddingsActive: boolean;
  /** One-line human summary of the embedding state (active / configured-but-no-key / off). */
  embeddingsAdvice: string;
  knowledgeDir: string;
  dataDir: string;
  /** Whether auto-comment is enabled in the effective config (opt-in: PLEX_AUTO_COMMENT or config.autoComment). */
  autoComment: boolean;
  /**
   * Repo data dirs whose `repo-path` file points to a path no longer on disk.
   * Present only when orphans exist. Remove them with `plex gc` (or manually).
   */
  orphanedRepos?: OrphanedRepo[];
}

/** Recursively sum a directory's size in bytes (best-effort; skips permission errors). */
export function dirSizeBytes(dir: string): number {
  try {
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      try {
        total += entry.isDirectory() ? dirSizeBytes(full) : statSync(full).size;
      } catch { /* skip unreadable entries */ }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Scan the centralized repos root and return entries whose `repo-path` sidecar points to
 * a path that no longer exists on disk (deleted worktrees, renamed/deleted repos, etc.).
 * Only dirs that contain a `repo-path` file are examined — pre-v0.3.3 dirs without one
 * are skipped rather than misidentified.
 */
export function findOrphanedRepos(reposRoot: string): OrphanedRepo[] {
  if (!existsSync(reposRoot)) return [];
  const orphans: OrphanedRepo[] = [];
  try {
    for (const entry of readdirSync(reposRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(reposRoot, entry.name);
      const repoPathFile = path.join(dir, 'repo-path');
      if (!existsSync(repoPathFile)) continue;
      let repoPath: string;
      try {
        repoPath = readFileSync(repoPathFile, 'utf8').trim();
      } catch {
        continue;
      }
      if (repoPath && !existsSync(repoPath)) {
        orphans.push({ dir, repoPath, sizeBytes: dirSizeBytes(dir) });
      }
    }
  } catch { /* best-effort */ }
  return orphans;
}

/**
 * Resolve the centralized repos root from config (mirrors repoPaths() logic).
 * Returns null for a relative dataDir (per-repo opt-in — no single root to scan).
 */
export function resolveReposRoot(config: ReviewerConfig): string | null {
  if (!config.dataDir) return path.join(os.homedir(), '.plex', 'repos');
  if (path.isAbsolute(config.dataDir)) return config.dataDir;
  return null; // relative = per-repo, can't scan a single root
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
  /** Whether the configured embedding provider resolves to a usable client (key present). Injected
   * by the caller (`embeddingReady`) so this report stays a pure, Kùzu-free function (the engine
   * barrel — which `embeddingReady` lives behind — must not load into the unit-tested doctor). */
  embeddingsActive: boolean;
}): DoctorReport {
  const { version, config, loadedBuildMs, onDiskBuildMs, node, pid, embeddingsActive } = args;
  const stale = onDiskBuildMs > loadedBuildMs + 1; // +1ms guards against mtime float jitter
  const iso = (ms: number): string => (ms > 0 ? new Date(ms).toISOString() : 'unknown');

  const reposRoot = resolveReposRoot(config);
  const orphanedRepos = reposRoot ? findOrphanedRepos(reposRoot) : undefined;

  const provider = config.embedding.provider;
  const embeddingsAdvice = embeddingsActive
    ? `Embeddings ACTIVE (${provider}) — semantic signals on, provider is being called.`
    : provider === 'none'
      ? 'Embeddings OFF (provider: none) — running on lexical/locality fallbacks. Set one with `plex init` or PLEX_EMBEDDING_PROVIDER + key.'
      : provider === 'fake'
        ? 'Embeddings use the test-only `fake` provider — no real provider is called.'
        : `Embeddings CONFIGURED as ${provider} but NO KEY resolves (${config.embedding.apiKeyEnv ?? `${provider.toUpperCase()}_API_KEY`} unset and no config.apiKey) — silently degrading to lexical, so NOTHING reaches ${provider} (this is why your dashboard shows no usage). Add the key via \`plex init\` or the env var.`;

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
    embeddings: provider,
    embeddingsActive,
    embeddingsAdvice,
    autoComment: config.autoComment,
    knowledgeDir: config.knowledgeDir,
    dataDir: config.dataDir || '(centralized: ~/.plex/repos/<id>)',
    ...(orphanedRepos && orphanedRepos.length > 0 ? { orphanedRepos } : {}),
  };
}
