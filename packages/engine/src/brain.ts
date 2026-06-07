import type {
  ReviewerConfig,
  ReviewNeighborhood,
  ReviewRound,
  PrComment,
  RankedFinding,
  VerdictKind,
  WaiverScope,
} from '@plex/core';
import { runFalkor, type FalkorStatement } from '@plex/neighborhood';
import { normalizeTitle } from '@plex/findings';

/**
 * The per-PR "brain" (ADR-22/23): a persistent FalkorDB graph per review target holding
 * rounds, findings, verdicts, and PR comments. It is REQUIRED for the review flow when
 * `falkordb.enabled` — there is no in-process fallback; if FalkorDB is down we throw a
 * clear error. All I/O goes through the isolated child worker (ADR-16) via runFalkor.
 *
 * Durability: FalkorDB runs with AOF (docker-compose `--appendonly yes`) so the brain
 * survives restarts; that is what makes the history "written down".
 */

const base = (p: string): string => p.split('/').pop() || p;
const excerpt = (s: string, n = 100): string => (s.length > n ? s.slice(0, n) + '…' : s);

/** Is the brain active? (Disabled = legacy/opt-out; tests run without FalkorDB.) */
export function brainEnabled(config: ReviewerConfig): boolean {
  return config.falkordb.enabled;
}

function falkorDown(reason: string | undefined, url: string): Error {
  return new Error(
    `FalkorDB is required for the review brain but is unreachable at ${url}` +
      `${reason ? ` (${reason})` : ''}. Start it with \`pnpm db:up\`, or set PLEX_FALKORDB_URL.`,
  );
}

export interface RoundSummary {
  n: number;
  ts: string;
  headSha?: string;
}

/** A prior finding/comment whose text the engine embeds for semantic change attribution. */
export interface BrainSignal {
  /** Raw text to embed (finding title / comment body). */
  text: string;
  /** Human-readable reason shown when this explains a change. */
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
  /** Prior-round findings that have no recorded outcome yet — candidates for fix inference. */
  priorFindings: BrainFinding[];
}

type Row = Record<string, unknown>;
const rows = (r: unknown): Row[] => (Array.isArray(r) ? (r as Row[]) : []);
const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));

/**
 * Probe FalkorDB (throws if down — requireFalkor semantics) and load the target's prior
 * rounds + the signals used for change attribution. A fresh target returns empty state.
 */
export async function loadRoundState(target: string, config: ReviewerConfig): Promise<RoundState> {
  const url = config.falkordb.url;
  const res = await runFalkor(
    target,
    [
      { cypher: 'RETURN 1 AS probe' }, // connectivity + lazily addresses the graph
      { cypher: 'MATCH (r:Round {target:$t}) RETURN r.n AS n, r.ts AS ts, r.headSha AS headSha ORDER BY r.n', params: { t: target } },
      { cypher: 'MATCH (fi:Finding {target:$t}) RETURN fi.file AS file, fi.line AS line, fi.title AS title', params: { t: target } },
      { cypher: 'MATCH (c:Comment {target:$t}) RETURN c.file AS file, c.line AS line, c.body AS body', params: { t: target } },
      {
        cypher:
          'MATCH (fi:Finding {target:$t}) WHERE fi.outcome IS NULL ' +
          'RETURN fi.id AS id, fi.file AS file, fi.line AS line, fi.title AS title',
        params: { t: target },
      },
    ],
    { url },
  );
  if (!res.ok) throw falkorDown(res.reason, url);

  const roundRows = rows(res.results?.[1]);
  const rounds: RoundSummary[] = roundRows.map((r) => ({ n: Number(r.n), ts: str(r.ts) ?? '', headSha: str(r.headSha) }));
  const last = rounds[rounds.length - 1];

  const signals: BrainSignal[] = [
    ...rows(res.results?.[2])
      .map((r) => ({ text: str(r.title) ?? '', file: str(r.file), label: `finding: ${excerpt(str(r.title) ?? '', 60)}` }))
      .filter((s) => s.text),
    ...rows(res.results?.[3])
      .map((r) => ({ text: str(r.body) ?? '', file: str(r.file), label: `comment: ${excerpt(str(r.body) ?? '', 60)}` }))
      .filter((s) => s.text),
  ];

  const priorFindings: BrainFinding[] = rows(res.results?.[4])
    .map((r) => ({ id: str(r.id) ?? '', file: str(r.file), line: r.line == null ? undefined : Number(r.line), title: str(r.title) ?? '' }))
    .filter((f) => f.id && f.title);

  return { lastN: last?.n ?? 0, lastHeadSha: last?.headSha, rounds, signals, priorFindings };
}

/** Mark a brain finding with an inferred outcome so it isn't re-evaluated (ADR-28). */
export async function markFindingOutcome(
  target: string,
  findingId: string,
  outcome: string,
  config: ReviewerConfig,
): Promise<void> {
  const url = config.falkordb.url;
  const res = await runFalkor(
    target,
    [{ cypher: 'MATCH (fi:Finding {id:$id}) SET fi.outcome = $o', params: { id: findingId, o: outcome } }],
    { url },
  );
  if (!res.ok) throw falkorDown(res.reason, url);
}

/** Write the PR hub + this round + its changed/blast edges + ingested comments. */
export async function recordRound(
  target: string,
  repo: string,
  round: ReviewRound,
  nb: ReviewNeighborhood,
  comments: PrComment[],
  config: ReviewerConfig,
): Promise<void> {
  const url = config.falkordb.url;
  const statements: FalkorStatement[] = [
    { cypher: 'MERGE (pr:PR {target:$t}) SET pr.repo=$repo, pr.name=$t', params: { t: target, repo } },
    {
      cypher:
        'MATCH (pr:PR {target:$t}) ' +
        'MERGE (r:Round {target:$t, n:$n}) SET r.ts=$ts, r.headSha=$headSha, r.baseRef=$baseRef, r.name=$rname ' +
        'MERGE (pr)-[:HAS_ROUND]->(r)',
      params: { t: target, n: round.n, ts: round.ts, headSha: round.headSha ?? null, baseRef: round.baseRef, rname: `round ${round.n}` },
    },
  ];
  for (const c of nb.changed) {
    statements.push({
      cypher:
        'MATCH (r:Round {target:$t, n:$n}) MERGE (f:File {path:$p}) SET f.name=$nm MERGE (r)-[:CHANGED]->(f)',
      params: { t: target, n: round.n, p: c.file, nm: base(c.file) },
    });
  }
  for (const nbr of nb.neighbors) {
    const p = String(nbr.node.props.path);
    statements.push({
      cypher:
        'MATCH (r:Round {target:$t, n:$n}) MERGE (f:File {path:$p}) SET f.name=$nm, f.score=$s, f.distance=$d ' +
        'MERGE (r)-[:BLAST {score:$s, via:$v}]->(f)',
      params: { t: target, n: round.n, p, nm: base(p), s: nbr.score, d: nbr.distance, v: (nbr.via || []).join(',') },
    });
  }
  for (const c of comments) {
    statements.push({
      cypher:
        'MATCH (r:Round {target:$t, n:$n}) ' +
        'MERGE (c:Comment {id:$id}) SET c.target=$t, c.body=$body, c.author=$author, c.file=$file, c.line=$line, c.name=$name ' +
        'MERGE (c)-[:IN_ROUND]->(r)',
      params: {
        t: target,
        n: round.n,
        id: c.id,
        body: c.body,
        author: c.author ?? null,
        file: c.file ?? null,
        line: c.line ?? null,
        name: excerpt(c.body, 40),
      },
    });
  }

  const res = await runFalkor(target, statements, { url });
  if (!res.ok) throw falkorDown(res.reason, url);
}

/** Persist the agent's ranked findings into the brain, tagged to a round. */
export async function writeFindings(
  target: string,
  roundN: number,
  findings: RankedFinding[],
  config: ReviewerConfig,
): Promise<void> {
  if (findings.length === 0) return;
  const url = config.falkordb.url;
  const statements: FalkorStatement[] = findings.map((f) => {
    const file = f.location.file;
    const line = f.location.startLine;
    const id = `${target}#${roundN}#${file}:${line}#${normalizeTitle(f.title)}`;
    return {
      cypher:
        'MATCH (r:Round {target:$t, n:$n}) ' +
        'MERGE (fi:Finding {id:$id}) SET fi.target=$t, fi.title=$title, fi.severity=$sev, fi.confidence=$conf, ' +
        'fi.signal=$signal, fi.source=$source, fi.file=$file, fi.line=$line, fi.triage=$triage, fi.name=$name ' +
        'MERGE (fi)-[:IN_ROUND]->(r) MERGE (f:File {path:$file}) SET f.name=$fnm MERGE (fi)-[:AT]->(f)',
      params: {
        t: target, n: roundN, id, title: f.title, sev: f.severity, conf: f.confidence, signal: f.signal,
        source: f.source, file, line, triage: f.triage, name: excerpt(f.title, 40), fnm: base(file),
      },
    };
  });
  const res = await runFalkor(target, statements, { url });
  if (!res.ok) throw falkorDown(res.reason, url);
}

/** Persist a verdict (accept/reject/waive) into the brain. */
export async function writeVerdict(
  target: string,
  roundN: number,
  verdict: { findingId: string; kind: VerdictKind; scope?: WaiverScope; title?: string; file?: string; line?: number; ts: string },
  config: ReviewerConfig,
): Promise<void> {
  const url = config.falkordb.url;
  const res = await runFalkor(
    target,
    [
      {
        cypher:
          'MERGE (r:Round {target:$t, n:$n}) ' +
          'MERGE (v:Verdict {target:$t, findingId:$fid}) SET v.kind=$kind, v.scope=$scope, v.ts=$ts, ' +
          'v.title=$title, v.file=$file, v.line=$line, v.name=$name MERGE (v)-[:IN_ROUND]->(r)',
        params: {
          t: target, n: roundN, fid: verdict.findingId, kind: verdict.kind, scope: verdict.scope ?? null,
          ts: verdict.ts, title: verdict.title ?? null, file: verdict.file ?? null, line: verdict.line ?? null,
          name: `${verdict.kind}: ${excerpt(verdict.title ?? verdict.findingId, 30)}`,
        },
      },
    ],
    { url },
  );
  if (!res.ok) throw falkorDown(res.reason, url);
}
