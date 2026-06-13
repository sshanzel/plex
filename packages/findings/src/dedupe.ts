import type { Finding, FindingSource, Severity } from '@plex/core';

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function dedupeKey(f: Finding): string {
  return `${f.location.file}:${f.location.startLine}:${normalizeTitle(f.title)}`;
}

export interface MergedFinding extends Finding {
  agreedSources: FindingSource[];
}

const SEVERITY_RANK: Record<Severity, number> = { bug: 3, improvement: 2, nit: 1, awareness: 0 };
function higherSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** Noisy-OR: independent sources agreeing raises confidence. */
function combineConfidence(a: number, b: number): number {
  return 1 - (1 - a) * (1 - b);
}

/**
 * Merge findings that describe the same issue from different sources (ADR-03). The
 * merged finding takes the highest severity, the corroborated confidence, the max blast
 * radius, and records which sources agreed (a confidence signal for ranking).
 */
export function dedupeFindings(findings: Finding[]): MergedFinding[] {
  const map = new Map<string, MergedFinding>();
  for (const f of findings) {
    const key = dedupeKey(f);
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { ...f, agreedSources: [f.source] });
      continue;
    }
    if (!cur.agreedSources.includes(f.source)) cur.agreedSources.push(f.source);
    cur.severity = higherSeverity(cur.severity, f.severity);
    cur.confidence = combineConfidence(cur.confidence, f.confidence);
    cur.blastRadius = Math.max(cur.blastRadius ?? 0, f.blastRadius ?? 0);
    cur.prevalence = cur.prevalence ?? f.prevalence;
    if (f.evidence?.length) cur.evidence = [...(cur.evidence ?? []), ...f.evidence];
    if (!cur.pitfallId && f.pitfallId) cur.pitfallId = f.pitfallId;
  }
  return [...map.values()];
}
