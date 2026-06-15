import { appendFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Verdict, Waiver, ReviewerConfig } from '@plex/core';
import { repoPaths, baseRepoPath } from './paths';

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
  const p = repoPaths(baseRepoPath(repoPath), config.dataDir); // base-keyed (ADR-46): survives worktree removal
  await mkdir(path.dirname(p.verdictsFile), { recursive: true });
  const rec: StoredVerdict = { ...input, ts: new Date().toISOString() };
  // Persist WITH the embedding (loadWaivers reads it back for next-round semantic matching),
  // but never RETURN it: the caller is the MCP/CLI surface that echoes this to the agent, and a
  // 1024-float waiver vector there is pure token waste no consumer reads (mirrors the rank/pitfall
  // strips). The on-disk log keeps the vector; the returned value drops it.
  await appendFile(p.verdictsFile, JSON.stringify(rec) + '\n', 'utf8');
  const { embedding: _embedding, ...slim } = rec;
  return slim;
}

export async function readVerdicts(
  repoPath: string,
  config: ReviewerConfig,
): Promise<StoredVerdict[]> {
  const p = repoPaths(baseRepoPath(repoPath), config.dataDir); // base-keyed (ADR-46): survives worktree removal
  let txt: string;
  try {
    txt = await readFile(p.verdictsFile, 'utf8');
  } catch {
    return []; // no log yet
  }
  // Parse PER LINE — a single corrupt record (a truncated final line from an interrupted append) must
  // not discard EVERY verdict. The old whole-file `.map(JSON.parse)` threw and the catch returned [],
  // silently wiping all waivers/suppressions so every dismissed finding re-surfaced (#10 silent-failure
  // audit). Same per-line resilience store.ts/audit.ts already apply to their JSONL logs.
  const out: StoredVerdict[] = [];
  for (const line of txt.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as StoredVerdict);
    } catch {
      /* skip the corrupt line, keep the rest */
    }
  }
  return out;
}

/**
 * Active suppression rules: a recorded verdict stops the SAME finding re-surfacing on later reviews,
 * so a dispositioned issue doesn't keep coming back. `waive` (a defect / false positive, ADR-10),
 * `acknowledge` (a confirmed-intentional `awareness` flag, ADR-31), and `reject` (the finding was
 * dismissed) all suppress. They match semantically when they carry an embedding, so a materially
 * changed instance still re-surfaces. `reject` ALSO down-weights the pitfall via the
 * outcome→confidence path; that is orthogonal to this instance-level suppression. (Without this,
 * a deterministic finding the author rejected — e.g. an intentional await-in-loop — re-ran and
 * re-surfaced every round, since codified checks recompute from scratch.)
 */
export async function loadWaivers(
  repoPath: string,
  config: ReviewerConfig,
  /**
   * Which verdict kinds become hard suppression rules. Defaults to all three for back-compat
   * (submit-time ranking). The review CONTEXT passes `['waive', 'acknowledge']` to EXCLUDE `reject`:
   * a single dismissal must not permanently bury a finding (a "not now / fix it next PR" is not a
   * "this is wrong"). `reject` is moving to the weighted negative-knowledge path — see
   * `docs/design/negative-knowledge.md` (C1). Until that lands, reject still hard-suppresses at
   * submit time (unchanged); only the up-front priming is softened here.
   */
  kinds: ReadonlySet<Verdict['kind']> = new Set(['waive', 'acknowledge', 'reject']),
): Promise<Waiver[]> {
  const stored = await readVerdicts(repoPath, config);
  return stored
    .filter((v) => kinds.has(v.kind))
    .map((v) => ({
      // A `reject` ("not now") defaults to INSTANCE (`line`) scope, never `file`: one reject must
      // silence only the exact finding it dismissed, not bury every unrelated finding in that file
      // (C1, ADR-39). `waive`/`acknowledge` keep the broader `file` default. A reject's repo-wide
      // effect comes only through the weighted negative-knowledge path, never a hard file waiver.
      scope: v.scope ?? (v.kind === 'reject' ? 'line' : 'file'),
      file: v.file,
      line: v.line,
      title: v.title,
      pattern: v.pattern,
      category: v.category,
      embedding: v.embedding,
    }));
}
