import parseDiff from 'parse-diff';
import { isGeneratedArtifact } from '@plex/core';
import type { NormalizedDiff, DiffFile, DiffFileStatus, DiffHunk, LineRange } from '@plex/core';

/** Group a set of line numbers into contiguous inclusive ranges. */
export function groupRanges(lines: number[]): LineRange[] {
  if (lines.length === 0) return [];
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: LineRange[] = [];
  let start = sorted[0]!;
  let prev = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i]!;
    if (n === prev + 1) {
      prev = n;
    } else {
      ranges.push({ start, end: prev });
      start = n;
      prev = n;
    }
  }
  ranges.push({ start, end: prev });
  return ranges;
}

/** Per-file added-line content + span — the text to embed for round attribution (ADR-23). */
export interface ChangedFileText {
  file: string;
  start: number;
  end: number;
  /** Added lines joined (capped) — the semantic content of the change. */
  text: string;
}

/**
 * Extract the added-line text per file from a unified diff. Pure — used to embed what
 * actually changed since the last round (no line-number heuristics; ADR-13/23).
 */
export function addedTextByFile(diffText: string): ChangedFileText[] {
  const out: ChangedFileText[] = [];
  for (const f of parseDiff(diffText)) {
    const file = f.to && f.to !== '/dev/null' ? f.to : f.from ?? 'unknown';
    // A regenerated lockfile/bundle is not "what changed" in any reviewable sense —
    // embedding 10k mechanical lines costs tokens and poisons change attribution.
    if (isGeneratedArtifact(file)) continue;
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    const texts: string[] = [];
    for (const c of f.chunks ?? []) {
      for (const ch of c.changes) {
        if (ch.type === 'add' && typeof ch.ln === 'number') {
          // Track min/max incrementally — a spread (`Math.min(...lines)`) overflows the call
          // stack on a file that adds ~100k+ lines (generated/vendored bundles).
          if (ch.ln < min) min = ch.ln;
          if (ch.ln > max) max = ch.ln;
          count++;
          texts.push(ch.content.replace(/^\+/, ''));
        }
      }
    }
    if (count === 0) continue;
    out.push({ file, start: min, end: max, text: texts.join('\n').slice(0, 4000) });
  }
  return out;
}

function statusOf(f: { new?: boolean; deleted?: boolean; from?: string; to?: string }): DiffFileStatus {
  if (f.new) return 'added';
  if (f.deleted) return 'deleted';
  if (f.from && f.to && f.from !== f.to && f.from !== '/dev/null' && f.to !== '/dev/null') {
    return 'renamed';
  }
  return 'modified';
}

/**
 * Parse a unified diff into the normalized form. Pure — no git/gh dependency,
 * so it is directly unit-testable (ADR-14: all inputs reduce to "diff vs base ref").
 */
export function normalizeUnifiedDiff(
  text: string,
  baseRef: string,
  headRef?: string,
): NormalizedDiff {
  // Generated artifacts (lockfiles, minified bundles, source maps, snapshots) are dropped
  // HERE, at the single entry point of the review flow — they never reach the context the
  // agent reads, the deterministic runner, or the brain's round bookkeeping. Their PATHS
  // are kept as a fact (`generatedPaths`): a lockfile-only diff is a supply-chain signal
  // worth a heads-up even though its content is never read.
  const generatedPaths: string[] = [];
  const files = parseDiff(text).filter((f) => {
    const p = f.to && f.to !== '/dev/null' ? f.to : f.from ?? 'unknown';
    if (isGeneratedArtifact(p)) {
      generatedPaths.push(p);
      return false;
    }
    return true;
  });
  const out: DiffFile[] = files.map((f) => {
    const path = f.to && f.to !== '/dev/null' ? f.to : f.from ?? 'unknown';
    const oldPath = f.from && f.from !== '/dev/null' && f.from !== f.to ? f.from : undefined;
    const hunks: DiffHunk[] = (f.chunks ?? []).map((c) => {
      const addLines: number[] = [];
      for (const ch of c.changes) {
        if (ch.type === 'add' && typeof ch.ln === 'number') addLines.push(ch.ln);
      }
      return {
        oldStart: c.oldStart,
        oldLines: c.oldLines,
        newStart: c.newStart,
        newLines: c.newLines,
        newRanges: groupRanges(addLines),
      };
    });
    return { path, oldPath, status: statusOf(f), hunks };
  });
  return { baseRef, headRef, files: out, ...(generatedPaths.length > 0 ? { generatedPaths } : {}) };
}
