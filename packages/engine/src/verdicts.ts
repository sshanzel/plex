import { appendFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { remapAnchor, type Verdict, type Waiver, type ReviewerConfig } from '@plex/core';
import { repoPaths, baseRepoPath } from './paths';

/** Identity fields captured at waive time so a waiver can re-match future findings. */
export interface WaiverIdentity {
  file?: string;
  line?: number;
  title?: string;
  pattern?: string;
  category?: string;
  /** The `file#name` symbol the waived finding was at (ADR-48) — scopes a file/line waiver to that symbol. */
  symbol?: string;
  /** Embedding of the waived finding for semantic re-matching (ADR-27). */
  embedding?: number[];
}

export type VerdictInput = Verdict & WaiverIdentity;
export interface StoredVerdict extends VerdictInput {
  ts: string;
}

/**
 * Append a verdict to the per-repo log — the seed of the feedback loop (ADR-10). A `waive` also records
 * identity fields so it can suppress matching findings next run.
 */
export async function recordVerdict(
  repoPath: string,
  input: VerdictInput,
  config: ReviewerConfig,
): Promise<StoredVerdict> {
  const p = repoPaths(baseRepoPath(repoPath), config.dataDir); // base-keyed (ADR-46): survives worktree removal
  await mkdir(path.dirname(p.verdictsFile), { recursive: true });
  const rec: StoredVerdict = { ...input, ts: new Date().toISOString() };
  // Persist WITH the embedding (loadWaivers reads it back for semantic matching) but never RETURN it —
  // a waiver vector echoed to the agent is token waste no consumer reads.
  await appendFile(p.verdictsFile, JSON.stringify(rec) + '\n', 'utf8');
  const { embedding: _embedding, ...slim } = rec;
  return slim;
}

/**
 * Atomically rewrite the whole verdict log (temp+rename, like `replaceIncidents`) — the rename-migration
 * writer (ADR-53). INVARIANT: pass the FULL set read via `readVerdicts` — a filter-then-replace would
 * silently drop every other verdict, so every dismissed finding would re-surface.
 */
export async function replaceVerdicts(
  repoPath: string,
  config: ReviewerConfig,
  verdicts: StoredVerdict[],
): Promise<void> {
  const p = repoPaths(baseRepoPath(repoPath), config.dataDir); // base-keyed (ADR-46): survives worktree removal
  await mkdir(path.dirname(p.verdictsFile), { recursive: true });
  const body = verdicts.length ? verdicts.map((v) => JSON.stringify(v)).join('\n') + '\n' : '';
  const tmp = `${p.verdictsFile}.tmp-${process.pid}`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, p.verdictsFile);
}

/**
 * Re-anchor stored verdicts' `file`/`symbol` across file renames (ADR-53) so a symbol-scoped `waive`/
 * `acknowledge`/`reject` keeps matching (and suppressing) at the new path instead of silently un-suppressing.
 * Pure. `renames` is old→new repo-relative POSIX. Returns the FULL set + `changed`, so a no-rename review
 * skips the rewrite.
 */
export function migrateWaiverAnchors(
  verdicts: StoredVerdict[],
  renames: ReadonlyMap<string, string>,
): { verdicts: StoredVerdict[]; changed: boolean } {
  let changed = false;
  const out = verdicts.map((v) => {
    const r = remapAnchor(renames, v.file, v.symbol);
    if (!r.changed) return v;
    changed = true;
    return {
      ...v,
      ...(v.file !== undefined ? { file: r.file } : {}),
      ...(v.symbol !== undefined ? { symbol: r.symbol } : {}),
    };
  });
  return { verdicts: out, changed };
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
  // Parse PER LINE — one corrupt record must not discard EVERY verdict (a whole-file parse would wipe
  // all waivers/suppressions so every dismissed finding re-surfaces, #10).
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
 * Active suppression rules: a recorded verdict stops the SAME finding re-surfacing on later reviews.
 * `waive` (ADR-10), `acknowledge` (ADR-31), and `reject` all suppress; they match semantically when
 * they carry an embedding, so a materially changed instance still re-surfaces. `reject` ALSO down-weights
 * the pitfall via the outcome→confidence path (orthogonal to this instance-level suppression).
 */
export async function loadWaivers(
  repoPath: string,
  config: ReviewerConfig,
  /** Which verdict kinds become hard suppression rules. The review CONTEXT passes
   *  `['waive', 'acknowledge']` to EXCLUDE `reject` — a single dismissal must not permanently bury a
   *  finding (C1); `reject` still hard-suppresses at submit time. */
  kinds: ReadonlySet<Verdict['kind']> = new Set(['waive', 'acknowledge', 'reject']),
): Promise<Waiver[]> {
  const stored = await readVerdicts(repoPath, config);
  return stored
    .filter((v) => kinds.has(v.kind))
    .map((v) => ({
      // A `reject` defaults to INSTANCE (`line`) scope, never `file` (C1, ADR-39): one reject silences
      // only the finding it dismissed; its repo-wide effect comes only via the negative-knowledge path.
      scope: v.scope ?? (v.kind === 'reject' ? 'line' : 'file'),
      file: v.file,
      line: v.line,
      title: v.title,
      pattern: v.pattern,
      category: v.category,
      symbol: v.symbol, // ADR-48: scopes a file/line waiver to the symbol it was recorded at
      embedding: v.embedding,
    }));
}
