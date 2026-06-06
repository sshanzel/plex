import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Finding, NormalizedDiff, LineRange } from '@plex/core';
import { analyzeSource, isSupportedSource, type RawFinding } from './builtin';

export interface DeterministicOptions {
  repoName?: string;
  /** Only emit findings on changed lines (default true) — review new code, not old. */
  onlyChangedRanges?: boolean;
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
  return out;
}
