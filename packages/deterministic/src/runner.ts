import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isGeneratedArtifact, languageOf, type Finding, type NormalizedDiff, type LineRange } from '@plex/core';
import { tryInitPython } from '@plex/lang-python';
import { type RawFinding } from './builtin';
import { analyzerFor, ruleLanguage } from './analyze';

export interface DeterministicOptions {
  repoName?: string;
  /** Only emit findings on changed lines (default true) — review new code, not old. */
  onlyChangedRanges?: boolean;
  /** Stamp each finding with its rule's MEASURED repo prevalence (default true) — grounds ADR-05's prevalence-by-severity read on data. */
  rulePrevalence?: boolean;
  /** Max files sampled for prevalence (breadth-first; default 400 — keeps the scan sub-second). */
  prevalenceFileCap?: number;
}

// Directories that never count toward prevalence (generated/vendored code isn't "the repo's style").
// Dot-dirs (.venv, .tox, …) are skipped wholesale below.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'venv', '__pycache__', 'site-packages']);

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
        if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name) && !e.name.endsWith('.egg-info')) {
          queue.push(path.join(dir, e.name));
        }
      } else if (analyzerFor(e.name) != null && !e.name.endsWith('.d.ts') && !isGeneratedArtifact(e.name)) {
        out.push(path.join(dir, e.name));
        if (out.length >= cap) break;
      }
    }
  }
  return out;
}

/**
 * Measure each rule's prevalence: the fraction of sampled SAME-LANGUAGE files with ≥1 hit (a rule
 * firing in 40% of the repo is a convention, not news). Per-language denominators keep a universal
 * Python habit in a mostly-TS monorepo from reading as "rare" and getting wrongly escalated (ADR-05).
 */
async function computeRulePrevalence(
  repoPath: string,
  rules: ReadonlySet<string>,
  cap: number,
): Promise<Map<string, number>> {
  const files = await listSourceFiles(repoPath, cap);
  if (files.length === 0) return new Map();
  // Only languages that OWN a measured rule are worth parsing: rule ids are 1:1 per language, so a
  // TS-only firing must not wasm-parse the repo's whole .py sample for guaranteed-zero hits.
  const measuredLangs = new Set<string>([...rules].map((r) => ruleLanguage(r)));
  const pyReady =
    measuredLangs.has('py') && files.some((f) => languageOf(f) === 'py') ? await tryInitPython() : false;
  const filesPerLang = new Map<string, number>();
  for (const f of files) {
    const lang = languageOf(f);
    if (lang) filesPerLang.set(lang, (filesPerLang.get(lang) ?? 0) + 1);
  }
  const hits = new Map<string, number>([...rules].map((r) => [r, 0]));
  // Read in parallel chunks (parse stays sequential — CPU-bound); fully sequential reads were IO-latency-bound.
  const CHUNK = 32;
  for (let i = 0; i < files.length; i += CHUNK) {
    const chunk = files.slice(i, i + CHUNK);
    const texts = await Promise.all(
      chunk.map(async (file) => {
        try {
          return await fs.readFile(file, 'utf8');
        } catch {
          return null;
        }
      }),
    );
    for (let j = 0; j < chunk.length; j++) {
      const text = texts[j];
      if (text == null) continue;
      const lang = languageOf(chunk[j]!);
      if (!lang || !measuredLangs.has(lang)) continue;
      const seen = new Set<string>();
      const analyze = analyzerFor(chunk[j]!);
      if (!analyze || (lang === 'py' && !pyReady)) continue;
      let raws: RawFinding[];
      try {
        raws = analyze(chunk[j]!, text);
      } catch {
        continue; // one pathological SAMPLED file must not fail the whole review
      }
      for (const raw of raws) {
        if (rules.has(raw.rule) && !seen.has(raw.rule)) {
          seen.add(raw.rule);
          hits.set(raw.rule, (hits.get(raw.rule) ?? 0) + 1);
        }
      }
    }
  }
  return new Map(
    [...hits].map(([rule, n]) => [rule, n / (filesPerLang.get(ruleLanguage(rule)) || files.length)]),
  );
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
    location: { repo, file, startLine: raw.startLine, endLine: raw.endLine, symbol: raw.symbol },
    tags: [raw.rule],
  };
}

export async function runDeterministic(
  repoPath: string,
  diff: NormalizedDiff,
  opts: DeterministicOptions = {},
): Promise<Finding[]> {
  const repo = opts.repoName ?? path.basename(path.resolve(repoPath));
  const onlyChanged = opts.onlyChangedRanges !== false;
  const out: Finding[] = [];
  // The wasm parser is the one async edge — hoisted here so analyzePySource stays sync/pure.
  // A failed load degrades to TS-only (skip .py files) rather than failing the whole review.
  const pyFiles = diff.files.filter((f) => f.status !== 'deleted' && languageOf(f.path) === 'py');
  const pyReady = pyFiles.length > 0 ? await tryInitPython() : false;
  if (pyFiles.length > 0 && !pyReady) {
    // Degradation must be IN-BAND (the graph side's honesty rule): an empty Python stream caused
    // by a dead runtime is not "clean". A note-severity finding (ADR-31 "worth confirming") rides
    // the normal pipeline — context, ranking, MCP — and is waivable like any other finding.
    out.push({
      id: `det:py-checks-skipped:${pyFiles[0]!.path}:1`,
      title: 'Python deterministic checks were SKIPPED — parser runtime unavailable',
      body: `The Python parser (wasm) failed to load, so ${pyFiles.length} Python file(s) in this diff were not analyzed. The empty Python stream is NOT "clean". This self-heals once the runtime loads (reconnect the MCP server if it persists).`,
      severity: 'note',
      confidence: 1,
      source: 'deterministic',
      location: { repo, file: pyFiles[0]!.path, startLine: 1, endLine: 1 },
      tags: ['py-checks-skipped'],
    });
  }
  // Canonicalize the repo root once so symlinks in repoPath itself don't false-positive the containment check.
  const realRoot = await fs.realpath(repoPath).catch(() => path.resolve(repoPath));

  for (const f of diff.files) {
    // Belt-and-suspenders for hand-built diffs (normalization already drops these; a .min.js IS "supported").
    const analyze = analyzerFor(f.path);
    if (f.status === 'deleted' || !analyze || isGeneratedArtifact(f.path)) continue;
    if (languageOf(f.path) === 'py' && !pyReady) continue;
    // Containment: a hostile diff can carry a path escaping the repo — lexically (`../../etc/x.ts`) OR via
    // a symlink in-tree. realpath resolves both before we read; never read outside the repo root.
    let text: string;
    try {
      const abs = await fs.realpath(path.join(repoPath, f.path));
      if (abs !== realRoot && !abs.startsWith(realRoot + path.sep)) continue;
      text = await fs.readFile(abs, 'utf8');
    } catch {
      continue; // missing file or unresolvable path — skip
    }
    const ranges = f.hunks.flatMap((h) => h.newRanges);
    let raws: RawFinding[];
    try {
      raws = analyze(f.path, text);
    } catch {
      continue; // per-file guard: a pathological file yields no findings, never a dead review
    }
    for (const raw of raws) {
      if (onlyChanged && ranges.length > 0 && !overlaps(raw, ranges)) continue;
      out.push(toFinding(raw, repo, f.path));
    }
  }

  // Stamp measured prevalence (only when something fired — the scan isn't free). The degradation
  // marker is a status fact, not a rule: it never drives (or receives) a prevalence measurement.
  const rules = new Set(
    out.map((f) => f.tags?.[0]).filter((t): t is string => t != null && t !== 'py-checks-skipped'),
  );
  if (opts.rulePrevalence !== false && rules.size > 0) {
    const prevalence = await computeRulePrevalence(repoPath, rules, opts.prevalenceFileCap ?? 400);
    for (const f of out) {
      const p = prevalence.get(f.tags?.[0] ?? '');
      if (p != null) f.prevalence = p;
    }
  }
  return out;
}
