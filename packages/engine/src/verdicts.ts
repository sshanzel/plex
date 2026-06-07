import { appendFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Verdict, Waiver, ReviewerConfig } from '@plex/core';
import { repoPaths } from './paths';

/** Identity fields captured at waive time so a waiver can re-match future findings. */
export interface WaiverIdentity {
  file?: string;
  line?: number;
  title?: string;
  pattern?: string;
  category?: string;
  /** Embedding of the waived finding for semantic re-matching (ADR-27). */
  embedding?: number[];
}

export type VerdictInput = Verdict & WaiverIdentity;
export interface StoredVerdict extends VerdictInput {
  ts: string;
}

/**
 * Append a verdict to the per-repo log — the seed of the feedback loop (ADR-10). A
 * `waive` also records identity fields so it can suppress matching findings next run.
 */
export async function recordVerdict(
  repoPath: string,
  input: VerdictInput,
  config: ReviewerConfig,
): Promise<StoredVerdict> {
  const p = repoPaths(repoPath, config.dataDir);
  await mkdir(path.dirname(p.verdictsFile), { recursive: true });
  const rec: StoredVerdict = { ...input, ts: new Date().toISOString() };
  await appendFile(p.verdictsFile, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

export async function readVerdicts(
  repoPath: string,
  config: ReviewerConfig,
): Promise<StoredVerdict[]> {
  const p = repoPaths(repoPath, config.dataDir);
  try {
    const txt = await readFile(p.verdictsFile, 'utf8');
    return txt
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as StoredVerdict);
  } catch {
    return [];
  }
}

/**
 * Active suppression rules. `waive` suppresses a defect (ADR-10); `acknowledge` suppresses
 * a confirmed-intentional `awareness` flag the same way (ADR-31) — both are matched
 * semantically when they carry an embedding, so a materially changed instance re-surfaces.
 */
export async function loadWaivers(repoPath: string, config: ReviewerConfig): Promise<Waiver[]> {
  const stored = await readVerdicts(repoPath, config);
  return stored
    .filter((v) => v.kind === 'waive' || v.kind === 'acknowledge')
    .map((v) => ({
      scope: v.scope ?? 'file',
      file: v.file,
      line: v.line,
      title: v.title,
      pattern: v.pattern,
      category: v.category,
      embedding: v.embedding,
    }));
}
