import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewerConfig, RankedFinding, VerdictKind, WaiverScope } from '@plex/core';
import { repoPaths } from './paths';

/**
 * Review audit log (ADR-24): append-only record of what was PROVIDED and SUBMITTED, never the
 * agent's chain-of-thought (ADR-02).
 */

interface AuditBase {
  repo: string;
  /** Correlation key — the review target (see reviewTarget). */
  target: string;
  /** Round number this event belongs to (ADR-23). */
  round: number;
  ts: string;
}

export interface ContextAssembledEvent extends AuditBase {
  type: 'context_assembled';
  baseRef: string;
  files: string[];
  /** Blast-radius nodes that were in view (id, coupling score, provenance). */
  blastRadius: { path: string; score: number; via: string[] }[];
  /** Retrieved pitfalls (id, similarity) — did knowledge help? */
  knowledge: { id: string; score: number }[];
  /** Was the author's stated intent available to check against? */
  changeContext: boolean;
  /** Regions changed since last round with nothing explaining them (ADR-23). */
  unexplainedChanges: number;
}

export interface FindingsSubmittedEvent extends AuditBase {
  type: 'findings_submitted';
  findings: {
    title: string;
    source: string;
    severity: string;
    confidence: number;
    signal: number;
    file: string;
    line: number;
    triage: string;
  }[];
  /** Learned-suppression decisions active for this review + their evidence basis (docs/design/negative-knowledge.md). */
  suppressions?: { key: string; tier: string; dismissals: number; corrections: number }[];
}

export interface OutcomeRecordedEvent extends AuditBase {
  type: 'outcome_recorded';
  findingId: string;
  kind: VerdictKind;
  scope?: WaiverScope;
}

export type AuditEvent = ContextAssembledEvent | FindingsSubmittedEvent | OutcomeRecordedEvent;

/** Append one event to `<repo>/.plex/log/events.jsonl`. Best-effort — never throws. */
export async function logAudit(
  repoPath: string,
  config: ReviewerConfig,
  event: AuditEvent,
): Promise<void> {
  try {
    const p = repoPaths(repoPath, config.dataDir);
    await mkdir(path.dirname(p.logFile), { recursive: true });
    await appendFile(p.logFile, JSON.stringify(event) + '\n', 'utf8');
  } catch {
    /* logging must never break a review */
  }
}

export async function readAudit(repoPath: string, config: ReviewerConfig): Promise<AuditEvent[]> {
  let txt: string;
  try {
    txt = await readFile(repoPaths(repoPath, config.dataDir).logFile, 'utf8');
  } catch {
    return [];
  }
  // Per-line parse: one corrupt event must not drop the whole audit trail.
  const out: AuditEvent[] = [];
  for (const line of txt.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as AuditEvent);
    } catch {
      /* skip the corrupt line */
    }
  }
  return out;
}

/** Shape a ranked finding for the findings_submitted event. */
export function auditFinding(f: RankedFinding): FindingsSubmittedEvent['findings'][number] {
  return {
    title: f.title,
    source: f.source,
    severity: f.severity,
    confidence: f.confidence,
    signal: f.signal,
    file: f.location.file,
    line: f.location.startLine,
    triage: f.triage,
  };
}
