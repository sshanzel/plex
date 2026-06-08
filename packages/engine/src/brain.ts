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
  /** Severity (bug|improvement|nit|awareness) — `awareness` is excluded from auto-accept (ADR-31). */
  severity?: string;
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

  /**
   * INVARIANT GUARD (permanent — not one-off migration; do not delete as "stale"): a review's
   * rounds and findings MUST live under one target. If they ever diverge — `canonicalTarget` has
   * findings but NO rounds of its own — realign them. The known historical cause was the
   * pre-`reviewTargetFor` worktree-seed bug (an old build keyed ROUNDS off the BASE repo name a
   * worktree copied via ADR-32, while findings used the dir basename), and that cause is fixed —
   * but this stays as a cheap safety net for the targeting layer, because a split is high-cost
   * (reconcile + fix-inference silently see no history) and recovery here is free.
   *
   * Adopt the sibling target holding this review's rounds — same `__pr_<n>` / `__<mode>` suffix,
   * different repo-name prefix — into the canonical target (with its comments + any stray
   * findings/verdicts). One brain file = one repo, so a same-suffix sibling is always THIS repo's
   * same review — safe to merge. Fires only on the split signature (findings, no own rounds), so a
   * healthy brain pays a single COUNT and a fresh target is a no-op. Returns what it merged, or null.
   */
  async healSplitTarget(canonicalTarget: string): Promise<{ from: string; rounds: number } | null> {
    const sep = canonicalTarget.indexOf('__');
    if (sep < 0) return null;
    const suffix = canonicalTarget.slice(sep); // e.g. "__pr_79" — the part after the repo prefix

    const own = await this.db.run('MATCH (r:Round {target:$t}) RETURN count(r) AS c', { t: canonicalTarget });
    if (Number(own[0]?.c ?? 0) > 0) return null; // canonical already has its own rounds — not split
    const finds = await this.db.run('MATCH (fi:Finding {target:$t}) RETURN count(fi) AS c', { t: canonicalTarget });
    if (Number(finds[0]?.c ?? 0) === 0) return null; // nothing to anchor — not the split signature

    // A sibling target that HAS rounds, shares the suffix, and whose prefix is everything before it.
    const targets = await this.db.run('MATCH (r:Round) RETURN DISTINCT r.target AS t');
    const from = targets
      .map((s) => str(s.t) ?? '')
      .find((t) => t !== canonicalTarget && t.endsWith(suffix) && t.indexOf('__') === t.length - suffix.length);
    if (!from) return null;

    const rc = await this.db.run('MATCH (r:Round {target:$f}) RETURN count(r) AS c', { f: from });
    for (const label of ['Round', 'Comment', 'Finding', 'Verdict']) {
      await this.db.run(`MATCH (n:${label} {target:$f}) SET n.target=$t`, { f: from, t: canonicalTarget });
    }
    return { from, rounds: Number(rc[0]?.c ?? 0) };
  }

  /** Load prior rounds + the signals/findings used for change attribution & fix inference. */
  async loadRoundState(target: string): Promise<RoundState> {
    const roundRows = await this.db.run(
      'MATCH (r:Round {target:$t}) RETURN r.n AS n, r.ts AS ts, r.headSha AS headSha ORDER BY r.n',
      { t: target },
    );
    const rounds: RoundSummary[] = roundRows.map((r) => ({ n: Number(r.n), ts: str(r.ts) ?? '', headSha: str(r.headSha) || undefined }));
    const last = rounds[rounds.length - 1];

    const findingRows = await this.db.run('MATCH (fi:Finding {target:$t}) RETURN fi.id AS id, fi.file AS file, fi.line AS line, fi.title AS title, fi.severity AS severity, fi.outcome AS outcome', { t: target });
    const commentRows = await this.db.run('MATCH (c:Comment {target:$t}) RETURN c.file AS file, c.body AS body', { t: target });

    const signals: BrainSignal[] = [
      ...findingRows.map((r) => ({ text: str(r.title) ?? '', file: str(r.file), label: `finding: ${excerpt(str(r.title) ?? '')}` })).filter((s) => s.text),
      ...commentRows.map((r) => ({ text: str(r.body) ?? '', file: str(r.file), label: `comment: ${excerpt(str(r.body) ?? '')}` })).filter((s) => s.text),
    ];
    const priorFindings: BrainFinding[] = findingRows
      .filter((r) => !str(r.outcome)) // un-outcomed ('' sentinel)
      .map((r) => ({ id: str(r.id) ?? '', file: str(r.file) || undefined, line: r.line == null ? undefined : Number(r.line), title: str(r.title) ?? '', severity: str(r.severity) }))
      .filter((f) => f.id && f.title);

    return { lastN: last?.n ?? 0, lastHeadSha: last?.headSha, rounds, signals, priorFindings };
  }

  /**
   * Every finding's ranking `signal` paired with its resolved outcome — the raw material for the
   * offline ranking-quality eval (tuning.md §5). Outcome is the explicit Verdict kind if one exists,
   * else the inferred `Finding.outcome` (`fixed`). Read-only; uses only data the review flow already
   * persists (no schema change). Across all targets/rounds in this repo's brain.
   */
  async rankingSamples(): Promise<{ target: string; round: number; id: string; signal: number; outcome: string }[]> {
    const finds = await this.db.run('MATCH (fi:Finding) RETURN fi.id AS id, fi.target AS target, fi.round AS round, fi.signal AS signal, fi.outcome AS outcome');
    const verds = await this.db.run('MATCH (v:Verdict) RETURN v.findingId AS fid, v.kind AS kind');
    const kindBy = new Map<string, string>();
    for (const v of verds) kindBy.set(str(v.fid) ?? '', str(v.kind) ?? '');
    return finds.map((r) => {
      const id = str(r.id) ?? '';
      return {
        target: str(r.target) ?? '',
        round: Number(r.round) || 0,
        id,
        signal: Number(r.signal) || 0,
        outcome: kindBy.get(id) || str(r.outcome) || '',
      };
    });
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

  /** Persist the agent's ranked findings with an empty outcome; `round` is the latest round raised.
   *
   * The id is keyed by target+file:line+title — NOT round (ADR-28 fix). A defect re-raised in a
   * later round (the agent re-reviews the whole diff and re-flags what's still unfixed) is the SAME
   * finding: keying by round minted a fresh node each round, so when the fix finally landed every
   * duplicate auto-accepted → multiple incidents (over-reinforcing the pitfall), and un-fixed
   * findings piled up one orphaned un-outcomed node per round (re-embedded as a signal every time).
   * Round-free identity makes re-raises idempotent; `ON MATCH SET fi.round` tracks the latest round
   * WITHOUT resetting the accrued `outcome` (a fixed finding stays fixed even if somehow re-raised). */
  async writeFindings(target: string, roundN: number, findings: RankedFinding[]): Promise<void> {
    await this.db.insertMany(
      'MERGE (fi:Finding {id:$id}) ON CREATE SET fi.outcome=$o, fi.target=$t, fi.title=$title, fi.severity=$sev, fi.confidence=$conf, fi.signal=$signal, fi.source=$source, fi.file=$file, fi.line=$line, fi.triage=$triage, fi.round=$round ' +
        'ON MATCH SET fi.title=$title, fi.severity=$sev, fi.confidence=$conf, fi.signal=$signal, fi.source=$source, fi.triage=$triage, fi.round=$round',
      findings.map((f) => ({
        id: `${target}#${f.location.file}:${f.location.startLine}#${normalizeTitle(f.title)}`,
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
