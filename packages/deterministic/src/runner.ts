import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Finding, NormalizedDiff, LineRange } from '@plex/core';
import { analyzeSource, isSupportedSource, type RawFinding } from './builtin';

export interface DeterministicOptions {
  repoName?: string;
  /** Only emit findings on changed lines (default true) — review new code, not old. */
  onlyChangedRanges?: boolean;
  /**
   * Stamp each finding with its rule's MEASURED repo prevalence (default true) — the
   * fraction of sampled source files with ≥1 hit of the same rule. This is what makes
   * ADR-05's prevalence-by-severity read rest on data for codified findings (common style
   * → convention; common bug → systemic) instead of an agent's guess.
   */
  rulePrevalence?: boolean;
  /** Max files sampled for prevalence (breadth-first; default 400 — keeps the scan sub-second). */
  prevalenceFileCap?: number;
}

// Directories that never count toward prevalence (generated/vendored code isn't "the repo's style").
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor']);

/** Breadth-first source-file listing, capped — prevalence is a sample, not a census. */
async function listSourceFiles(root: string, cap: number): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0 && out.length < cap) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) queue.push(path.join(dir, e.name));
      } else if (isSupportedSource(e.name) && !e.name.endsWith('.d.ts')) {
        out.push(path.join(dir, e.name));
        if (out.length >= cap) break;
      }
    }
  }
  return out;
}

/**
 * Measure each rule's prevalence: the fraction of sampled files with ≥1 hit. A rule firing
 * in 40% of the repo is a convention (or a systemic bug), not news about this diff.
 */
async function computeRulePrevalence(
  repoPath: string,
  rules: ReadonlySet<string>,
  cap: number,
): Promise<Map<string, number>> {
  const files = await listSourceFiles(repoPath, cap);
  if (files.length === 0) return new Map();
  const hits = new Map<string, number>([...rules].map((r) => [r, 0]));
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const seen = new Set<string>();
    for (const raw of analyzeSource(file, text)) {
      if (rules.has(raw.rule) && !seen.has(raw.rule)) {
        seen.add(raw.rule);
        hits.set(raw.rule, (hits.get(raw.rule) ?? 0) + 1);
      }
    }
  }
  return new Map([...hits].map(([rule, n]) => [rule, n / files.length]));
}

function overlaps(raw: RawFinding, ranges: LineRange[]): boolean {
  return ranges.some((r) => raw.startLine <= r.end && r.start <= raw.endLine);
}

function toFinding(raw: RawFinding, repo: string, file: string): Finding {
  return {
    id: `det:${raw.rule}:${file}:${raw.startLine}`,
    title: raw.title,
    body: raw.body,
    severity: raw.severity,
    confidence: raw.confidence,
    source: 'deterministic',
    location: { repo, file, startLine: raw.startLine, endLine: raw.endLine },
    tags: [raw.rule],
  };
}

/** Run deterministic checks across a diff's changed files, scoped to changed lines. */
export async function runDeterministic(
  repoPath: string,
  diff: NormalizedDiff,
  opts: DeterministicOptions = {},
): Promise<Finding[]> {
  const repo = opts.repoName ?? path.basename(path.resolve(repoPath));
  const onlyChanged = opts.onlyChangedRanges !== false;
  const out: Finding[] = [];

  for (const f of diff.files) {
    if (f.status === 'deleted' || !isSupportedSource(f.path)) continue;
    let text: string;
    try {
      text = await fs.readFile(path.join(repoPath, f.path), 'utf8');
    } catch {
      continue;
    }
    const ranges = f.hunks.flatMap((h) => h.newRanges);
    for (const raw of analyzeSource(f.path, text)) {
      if (onlyChanged && ranges.length > 0 && !overlaps(raw, ranges)) continue;
      out.push(toFinding(raw, repo, f.path));
    }
  }

  // Stamp measured prevalence (only when something fired — the scan isn't free).
  if (opts.rulePrevalence !== false && out.length > 0) {
    const rules = new Set(out.map((f) => f.tags?.[0]).filter((t): t is string => t != null));
    const prevalence = await computeRulePrevalence(repoPath, rules, opts.prevalenceFileCap ?? 400);
    for (const f of out) {
      const p = prevalence.get(f.tags?.[0] ?? '');
      if (p != null) f.prevalence = p;
    }
  }
  return out;
}
