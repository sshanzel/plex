/**
 * The durable lineage layer (ADR-46) is an append-only JSONL **event log** per review target; this
 * module is the **pure fold** that replays events → current state. No I/O — the engine's `Brain` and
 * the viz-server's `collect` each read their own files and call `foldLineage`, so the
 * last-write-wins / outcome-stickiness rules live in exactly one place (and `@plex/core` stays
 * dependency-free).
 *
 * **Outcome is orthogonal to the finding record** (mirrors the retired Kùzu brain, ADR-28): a
 * `finding` event updates every field EXCEPT outcome (`writeFindings` was `ON CREATE outcome='' / ON
 * MATCH …` — never touching outcome); only an `outcome` event sets it (`markFindingOutcome`). So a
 * re-raised finding never resets a `fixed`/dispositioned outcome — the single most important rule.
 */

export type LineageEvent =
  | { k: 'round'; target: string; n: number; ts: string; headSha: string; baseRef: string }
  | {
      k: 'finding';
      target: string;
      id: string;
      title: string;
      severity: string;
      confidence: number;
      signal: number;
      source: string;
      file: string;
      line: number;
      triage: string;
      round: number;
      blast: number;
      prevalence: number;
      agreement: number;
      rule: string;
    }
  | { k: 'comment'; target: string; id: string; body: string; author: string; file: string; line: number }
  | { k: 'verdict'; target: string; findingId: string; kind: string; scope: string; ts: string; title: string; file: string; line: number }
  | { k: 'outcome'; target: string; findingId: string; outcome: string };

export interface FoldedRound {
  n: number;
  ts: string;
  headSha: string;
  baseRef: string;
}
export interface FoldedFinding {
  id: string;
  title: string;
  severity: string;
  confidence: number;
  signal: number;
  source: string;
  file: string;
  line: number;
  triage: string;
  round: number;
  blast: number;
  prevalence: number;
  agreement: number;
  rule: string;
}
export interface FoldedComment {
  id: string;
  body: string;
  author: string;
  file: string;
  line: number;
}
export interface FoldedVerdict {
  findingId: string;
  kind: string;
  scope: string;
  ts: string;
  title: string;
  file: string;
  line: number;
}

export interface LineageView {
  /** Rounds ascending by `n`. */
  rounds: FoldedRound[];
  findings: FoldedFinding[];
  comments: FoldedComment[];
  verdicts: FoldedVerdict[];
  /** Effective outcome for a finding id (`''` when none) — set only by `outcome` events. */
  outcomeOf: (findingId: string) => string;
}

/** Replay events into current state (last-write-wins per id; outcome tracked separately). */
export function foldLineage(events: LineageEvent[]): LineageView {
  const rounds = new Map<number, FoldedRound>();
  const findings = new Map<string, FoldedFinding>();
  const comments = new Map<string, FoldedComment>();
  const verdicts = new Map<string, FoldedVerdict>(); // keyed by findingId (writeVerdict id = target#findingId)
  const outcomes = new Map<string, string>(); // finding id → outcome

  for (const e of events) {
    switch (e.k) {
      case 'round':
        rounds.set(e.n, { n: e.n, ts: e.ts, headSha: e.headSha, baseRef: e.baseRef });
        break;
      case 'finding':
        findings.set(e.id, {
          id: e.id, title: e.title, severity: e.severity, confidence: e.confidence, signal: e.signal,
          source: e.source, file: e.file, line: e.line, triage: e.triage, round: e.round,
          blast: e.blast, prevalence: e.prevalence, agreement: e.agreement, rule: e.rule,
        });
        break;
      case 'comment':
        comments.set(e.id, { id: e.id, body: e.body, author: e.author, file: e.file, line: e.line });
        break;
      case 'verdict':
        verdicts.set(e.findingId, { findingId: e.findingId, kind: e.kind, scope: e.scope, ts: e.ts, title: e.title, file: e.file, line: e.line });
        break;
      case 'outcome':
        outcomes.set(e.findingId, e.outcome);
        break;
    }
  }

  return {
    rounds: [...rounds.values()].sort((a, b) => a.n - b.n),
    findings: [...findings.values()],
    comments: [...comments.values()],
    verdicts: [...verdicts.values()],
    outcomeOf: (id) => outcomes.get(id) ?? '',
  };
}

/** Parse a JSONL lineage file body into events, skipping blank/corrupt lines (never throws). */
export function parseLineageEvents(body: string): LineageEvent[] {
  const out: LineageEvent[] = [];
  for (const line of body.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as LineageEvent);
    } catch {
      /* skip a torn final line — never discard the rest */
    }
  }
  return out;
}
