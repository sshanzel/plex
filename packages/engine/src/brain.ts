import type {
  ReviewerConfig,
  ReviewRound,
  PrComment,
  RankedFinding,
  VerdictKind,
  WaiverScope,
} from '@plex/core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { CodeGraphDB } from '@plex/code-graph';
import { normalizeTitle } from '@plex/findings';
import { repoPaths } from './paths';

/**
 * The per-PR "brain" (ADR-22/23/30): a per-repo **Kùzu** database holding rounds, findings,
 * verdicts, and PR comments as typed nodes keyed by review target. Embedded — no service,
 * no Docker, and no cross-engine SIGSEGV (it's the same engine as the code graph; ADR-30
 * replaces the FalkorDB brain). One `Brain` handle is opened per review and reused for all
 * that review's brain I/O (avoids reopening the same Kùzu file concurrently).
 */

const excerpt = (s: string, n = 60): string => (s.length > n ? s.slice(0, n) + '…' : s);

const SCHEMA = [
  'CREATE NODE TABLE IF NOT EXISTS Round(id STRING, target STRING, n INT64, ts STRING, headSha STRING, baseRef STRING, PRIMARY KEY(id))',
  'CREATE NODE TABLE IF NOT EXISTS Finding(id STRING, target STRING, title STRING, severity STRING, confidence DOUBLE, signal DOUBLE, source STRING, file STRING, line INT64, triage STRING, outcome STRING, round INT64, PRIMARY KEY(id))',
  'CREATE NODE TABLE IF NOT EXISTS Verdict(id STRING, target STRING, findingId STRING, kind STRING, scope STRING, ts STRING, title STRING, file STRING, line INT64, PRIMARY KEY(id))',
  'CREATE NODE TABLE IF NOT EXISTS Comment(id STRING, target STRING, body STRING, author STRING, file STRING, line INT64, PRIMARY KEY(id))',
];

export interface RoundSummary {
  n: number;
  ts: string;
  headSha?: string;
}

/** A prior finding/comment whose text the engine embeds for semantic change attribution. */
export interface BrainSignal {
  text: string;
  label: string;
  file?: string;
}

/** A prior-round finding with identity, for autonomous outcome inference (ADR-28). */
export interface BrainFinding {
  id: string;
  file?: string;
  line?: number;
  title: string;
}

export interface RoundState {
  /** Highest round number recorded for this target (0 = none yet). */
  lastN: number;
  /** Head SHA of the most recent round (to diff "what changed since last round"). */
  lastHeadSha?: string;
  rounds: RoundSummary[];
  /** Prior findings + comments as signals for change attribution (embedded by the engine). */
  signals: BrainSignal[];
  /** Prior-round findings with no recorded outcome yet — candidates for fix inference. */
  priorFindings: BrainFinding[];
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));

/** A per-repo brain connection (Kùzu). Open once per review; reuse for all its brain I/O. */
export class Brain {
  private readonly db: CodeGraphDB;
  constructor(brainDir: string) {
    mkdirSync(path.dirname(brainDir), { recursive: true }); // Kùzu needs the parent dir to exist
    this.db = new CodeGraphDB(brainDir);
  }

  static async open(repoPath: string, config: ReviewerConfig): Promise<Brain> {
    const b = new Brain(repoPaths(repoPath, config.dataDir).brainDir);
    for (const ddl of SCHEMA) await b.db.run(ddl);
    return b;
  }

  close(): Promise<void> {
    return this.db.close();
  }

  /** Load prior rounds + the signals/findings used for change attribution & fix inference. */
  async loadRoundState(target: string): Promise<RoundState> {
    const roundRows = await this.db.run(
      'MATCH (r:Round {target:$t}) RETURN r.n AS n, r.ts AS ts, r.headSha AS headSha ORDER BY r.n',
      { t: target },
    );
    const rounds: RoundSummary[] = roundRows.map((r) => ({ n: Number(r.n), ts: str(r.ts) ?? '', headSha: str(r.headSha) || undefined }));
    const last = rounds[rounds.length - 1];

    const findingRows = await this.db.run('MATCH (fi:Finding {target:$t}) RETURN fi.id AS id, fi.file AS file, fi.line AS line, fi.title AS title, fi.outcome AS outcome', { t: target });
    const commentRows = await this.db.run('MATCH (c:Comment {target:$t}) RETURN c.file AS file, c.body AS body', { t: target });

    const signals: BrainSignal[] = [
      ...findingRows.map((r) => ({ text: str(r.title) ?? '', file: str(r.file), label: `finding: ${excerpt(str(r.title) ?? '')}` })).filter((s) => s.text),
      ...commentRows.map((r) => ({ text: str(r.body) ?? '', file: str(r.file), label: `comment: ${excerpt(str(r.body) ?? '')}` })).filter((s) => s.text),
    ];
    const priorFindings: BrainFinding[] = findingRows
      .filter((r) => !str(r.outcome)) // un-outcomed ('' sentinel)
      .map((r) => ({ id: str(r.id) ?? '', file: str(r.file) || undefined, line: r.line == null ? undefined : Number(r.line), title: str(r.title) ?? '' }))
      .filter((f) => f.id && f.title);

    return { lastN: last?.n ?? 0, lastHeadSha: last?.headSha, rounds, signals, priorFindings };
  }

  /** Record this round + its ingested PR comments. */
  async recordRound(target: string, round: ReviewRound, comments: PrComment[]): Promise<void> {
    const rid = `${target}#${round.n}`;
    await this.db.run(
      'MERGE (r:Round {id:$id}) SET r.target=$t, r.n=$n, r.ts=$ts, r.headSha=$h, r.baseRef=$b',
      { id: rid, t: target, n: round.n, ts: round.ts, h: round.headSha ?? '', b: round.baseRef },
    );
    await this.db.insertMany(
      'MERGE (c:Comment {id:$id}) SET c.target=$t, c.body=$body, c.author=$author, c.file=$file, c.line=$line',
      comments.map((c) => ({ id: `${target}#${c.id}`, t: target, body: c.body, author: c.author ?? '', file: c.file ?? '', line: c.line ?? -1 })),
    );
  }

  /** Persist the agent's ranked findings, round-tagged, with an empty outcome. */
  async writeFindings(target: string, roundN: number, findings: RankedFinding[]): Promise<void> {
    await this.db.insertMany(
      'MERGE (fi:Finding {id:$id}) ON CREATE SET fi.outcome=$o, fi.target=$t, fi.title=$title, fi.severity=$sev, fi.confidence=$conf, fi.signal=$signal, fi.source=$source, fi.file=$file, fi.line=$line, fi.triage=$triage, fi.round=$round ' +
        'ON MATCH SET fi.title=$title, fi.severity=$sev, fi.confidence=$conf, fi.signal=$signal, fi.source=$source, fi.triage=$triage',
      findings.map((f) => ({
        id: `${target}#${roundN}#${f.location.file}:${f.location.startLine}#${normalizeTitle(f.title)}`,
        o: '', t: target, title: f.title, sev: f.severity, conf: f.confidence, signal: f.signal,
        source: f.source, file: f.location.file, line: f.location.startLine, triage: f.triage, round: roundN,
      })),
    );
  }

  /** Persist a verdict (accept/reject/waive). */
  async writeVerdict(
    target: string,
    verdict: { findingId: string; kind: VerdictKind; scope?: WaiverScope; title?: string; file?: string; line?: number; ts: string },
  ): Promise<void> {
    await this.db.run(
      'MERGE (v:Verdict {id:$id}) SET v.target=$t, v.findingId=$fid, v.kind=$kind, v.scope=$scope, v.ts=$ts, v.title=$title, v.file=$file, v.line=$line',
      {
        id: `${target}#${verdict.findingId}`, t: target, fid: verdict.findingId, kind: verdict.kind,
        scope: verdict.scope ?? '', ts: verdict.ts, title: verdict.title ?? '', file: verdict.file ?? '', line: verdict.line ?? -1,
      },
    );
  }

  /** Mark a finding with an inferred outcome so it isn't re-evaluated (ADR-28). */
  async markFindingOutcome(findingId: string, outcome: string): Promise<void> {
    await this.db.run('MATCH (fi:Finding {id:$id}) SET fi.outcome=$o', { id: findingId, o: outcome });
  }
}
