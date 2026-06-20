import os from 'node:os';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { ReviewerConfig } from '@plex/core';

/** The repos root to enumerate (mirrors engine `repoPaths` without importing it): empty `dataDir` →
 *  `~/.plex/repos`; absolute → that path; relative (in-repo opt-in) → null, picker empty (ADR-45). */
export function reposRoot(config: ReviewerConfig): string | null {
  const d = config.dataDir;
  if (!d) return path.join(os.homedir(), '.plex', 'repos');
  if (path.isAbsolute(d)) return d;
  return null;
}

export interface RepoEntry {
  /** The data-dir name (`<basename>-<sha1[:8]>`) — the id used in API requests. */
  id: string;
  /** Friendly name for the picker (the repo's basename). */
  name: string;
  /** Absolute source repo path, if recorded (`repo-path` sidecar). */
  repoPath?: string;
  reviewerDir: string;
  graphDir: string;
  /** Durable lineage layer dir (ADR-46) — `<reviewerDir>/lineage/`, per-target JSONL files. */
  lineageDir: string;
  hasGraph: boolean;
  hasLineage: boolean;
}

/** Only ever accept ids of this shape — `repoId` mints exactly this, and it forbids `.`/`/` traversal. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function entryFor(root: string, id: string): RepoEntry | null {
  if (!SAFE_ID.test(id) || id === '.' || id === '..') return null;
  const reviewerDir = path.join(root, id);
  // Defence in depth: the resolved dir must remain a direct child of the root (no `..` escape even
  // if SAFE_ID is ever loosened). path.resolve collapses any traversal before the prefix check.
  if (path.dirname(path.resolve(reviewerDir)) !== path.resolve(root)) return null;
  let isDir = false;
  try {
    isDir = statSync(reviewerDir).isDirectory();
  } catch {
    return null;
  }
  if (!isDir) return null;
  const graphDir = path.join(reviewerDir, 'graph.kuzu');
  const lineageDir = path.join(reviewerDir, 'lineage');
  const hasGraph = existsSync(graphDir);
  const hasLineage = existsSync(lineageDir);
  if (!hasGraph && !hasLineage) return null; // a dir with neither store isn't a usable repo
  let repoPath: string | undefined;
  try {
    repoPath = readFileSync(path.join(reviewerDir, 'repo-path'), 'utf8').trim() || undefined;
  } catch {
    /* sidecar absent (older index) — fall back to the id-derived name */
  }
  const name = repoPath ? path.basename(repoPath) : id.replace(/-[0-9a-f]{8}$/, '');
  return { id, name, repoPath, reviewerDir, graphDir, lineageDir, hasGraph, hasLineage };
}

/** Every indexed repo on this machine, newest data dir first. */
export function listRepos(config: ReviewerConfig): RepoEntry[] {
  const root = reposRoot(config);
  if (!root || !existsSync(root)) return [];
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch {
    return [];
  }
  const out: RepoEntry[] = [];
  for (const id of ids) {
    const e = entryFor(root, id);
    if (e) out.push(e);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a requested repo id to its entry, or null if unknown — the path-traversal gate (ADR-45). */
export function resolveRepo(config: ReviewerConfig, id: string): RepoEntry | null {
  const root = reposRoot(config);
  if (!root) return null;
  const e = entryFor(root, id);
  // entryFor already validates shape + containment; existence is implied by it returning non-null.
  return e;
}
