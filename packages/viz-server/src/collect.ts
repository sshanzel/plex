import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodeGraphDB } from '@plex/code-graph';
import { KnowledgeStore } from '@plex/knowledge';
import { foldLineage, parseLineageEvents, symbolKey, type Pitfall, type Incident } from '@plex/core';
import { type GraphPayload, type VizEdge, type VizNode, emptyPayload, withCounts } from './model';
import type { RepoEntry } from './registry';

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown): number => Number(v) || 0;

/** The Incident viz node — shared by the knowledge graph and the code-graph symbol↔incident join, so
 *  both render an incident identically (same id, so dedup works across a merged view). */
function incidentVizNode(i: Incident): VizNode {
  return {
    id: `inc:${i.id}`,
    label: i.note || i.file || i.id,
    type: 'Incident',
    graph: 'knowledge',
    props: {
      source: i.source, outcome: i.outcome ?? '', repo: i.repo ?? '', file: i.file ?? '',
      // Code-path anchor (code-path memory): where this concern was raised.
      symbol: i.symbol ?? '', line: i.line ?? -1,
      verb: i.verb ?? '', ts: i.ts, snippet: (i.snippet ?? '').slice(0, 200),
      // Tier-2 provenance (ADR-46): the review event this came from — drives a recorded lineage edge.
      findingId: i.findingId ?? '', target: i.target ?? '',
    },
  };
}

/** Per-graph node cap — keeps a huge monorepo's payload (and the browser) responsive. Hitting it
 *  sets `truncated`, which the UI surfaces, so a partial graph never silently reads as complete. */
const DEFAULT_NODE_CAP = 800;

/** A PR comment is linked to a finding in the same file when their lines are within this many rows
 *  (the brain stores no explicit comment→finding edge, so locality is the honest correlation). */
const COMMENT_LINK_WINDOW = 25;

/**
 * Open Kùzu, run `fn`, ALWAYS close — the daemon must never hold a handle across requests (Kùzu is
 * single-writer; a held lock would make a concurrent review throw `RepoBusyError`, ADR-45). A
 * `RepoBusyError` from the open itself (a review holds the lock right now) propagates so the server
 * maps it to a 503 retry.
 */
async function withGraph<T>(dir: string, fn: (db: CodeGraphDB) => Promise<T>): Promise<T> {
  const db = new CodeGraphDB(dir);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

// ---------------------------------------------------------------------------
// Code graph: File nodes + Imports/Refs/CoChange edges (symbols load on expand)
// ---------------------------------------------------------------------------

export async function collectCode(repo: RepoEntry, cap = DEFAULT_NODE_CAP): Promise<GraphPayload> {
  if (!repo.hasGraph || !existsSync(repo.graphDir)) {
    return emptyPayload('code', 'This repo has no code graph yet — run `plex index`.');
  }
  return withGraph(repo.graphDir, async (db) => {
    const files = await db.run('MATCH (f:File) RETURN f.id AS id, f.path AS path, f.lang AS lang');
    const truncated = files.length > cap;
    const slice = files.slice(0, cap);
    const included = new Set(slice.map((r) => str(r.id)));

    // Symbol count per file (for the panel + node sizing) — one grouped query, not per-file.
    const symCounts = new Map<string, number>();
    for (const r of await db.run('MATCH (s:Symbol) RETURN s.file AS file, count(s) AS c')) {
      symCounts.set(str(r.file), num(r.c));
    }

    const nodes: VizNode[] = slice.map((r) => {
      const id = str(r.id);
      return {
        id: `f:${id}`,
        label: id,
        type: 'File',
        graph: 'code',
        props: { path: str(r.path) || id, lang: str(r.lang), symbols: symCounts.get(id) ?? 0 },
      };
    });

    const edges: VizEdge[] = [];
    const seen = new Set<string>();
    const addEdge = (sRaw: string, tRaw: string, label: string, undirected: boolean): void => {
      if (!included.has(sRaw) || !included.has(tRaw) || sRaw === tRaw) return;
      // Co-change is symmetric → canonicalize endpoints so an a↔b pair is one edge, not two.
      const [a, b] = undirected && sRaw > tRaw ? [tRaw, sRaw] : [sRaw, tRaw];
      const key = `${label}|${a}|${b}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ id: key, source: `f:${a}`, target: `f:${b}`, label, graph: 'code' });
    };
    for (const r of await db.run('MATCH (a:File)-[:Imports]->(b:File) RETURN a.id AS s, b.id AS t')) {
      addEdge(str(r.s), str(r.t), 'import', false);
    }
    for (const r of await db.run('MATCH (a:File)-[:Refs]->(b:File) RETURN a.id AS s, b.id AS t')) {
      addEdge(str(r.s), str(r.t), 'ref', false);
    }
    for (const r of await db.run('MATCH (a:File)-[c:CoChange]->(b:File) RETURN a.id AS s, b.id AS t')) {
      addEdge(str(r.s), str(r.t), 'co-change', true);
    }

    const note = truncated
      ? `Showing ${cap} of ${files.length} files (capped). Use search to find a specific file.`
      : undefined;
    return withCounts({ graph: 'code', nodes, edges, truncated, counts: {}, note });
  });
}

interface SymbolDesc {
  nodeId: string;
  name: string;
  startLine: number;
  endLine: number;
}

/** Expand one File: its symbols (+ Declares edges), immediate file neighbors, and — when a knowledge
 *  dir is given — the recorded concerns anchored at each symbol (code-path memory). For click-to-walk. */
export async function expandCodeFile(
  repo: RepoEntry,
  fileId: string,
  knowledgeDir?: string,
): Promise<{ nodes: VizNode[]; edges: VizEdge[] }> {
  if (!repo.hasGraph || !existsSync(repo.graphDir)) return { nodes: [], edges: [] };
  const { nodes, edges, syms } = await withGraph(repo.graphDir, async (db) => {
    const nodes: VizNode[] = [];
    const edges: VizEdge[] = [];
    const syms: SymbolDesc[] = [];
    const symbols = await db.run(
      'MATCH (s:Symbol {file:$file}) RETURN s.id AS id, s.name AS name, s.kind AS kind, s.startLine AS startLine, s.endLine AS endLine, s.exported AS exported',
      { file: fileId },
    );
    for (const r of symbols) {
      const id = `s:${str(r.id)}`;
      nodes.push({
        id,
        label: str(r.name),
        type: 'Symbol',
        graph: 'code',
        props: { kind: str(r.kind), startLine: num(r.startLine), endLine: num(r.endLine), exported: Boolean(r.exported) },
      });
      edges.push({ id: `decl|${fileId}|${str(r.id)}`, source: `f:${fileId}`, target: id, label: 'declares', graph: 'code' });
      syms.push({ nodeId: id, name: str(r.name), startLine: num(r.startLine), endLine: num(r.endLine) });
    }
    // Immediate file neighbors (any provenance) so a click keeps the walk going.
    for (const r of await db.run(
      'MATCH (a:File {id:$id})-[e:Imports|Refs|CoChange]-(b:File) RETURN DISTINCT b.id AS nb, b.path AS path, b.lang AS lang',
      { id: fileId },
    )) {
      const nb = str(r.nb);
      if (!nb || nb === fileId) continue;
      nodes.push({ id: `f:${nb}`, label: nb, type: 'File', graph: 'code', props: { path: str(r.path) || nb, lang: str(r.lang) } });
      edges.push({ id: `nbr|${fileId}|${nb}`, source: `f:${fileId}`, target: `f:${nb}`, label: 'coupled', graph: 'code' });
    }
    return { nodes, edges, syms };
  });
  // Symbol↔incident join (code-path memory) — runs AFTER the Kùzu handle is closed (no held lock):
  // bridge each symbol to the recorded concerns at it, by `file#name` key (solid) or line-overlap (dashed).
  if (knowledgeDir) await linkSymbolIncidents({ nodes, edges }, fileId, syms, knowledgeDir);
  return { nodes, edges };
}

/** Per symbol-of-a-file, add Incident nodes + `concerns` edges for the incidents anchored there.
 *  Pure-ish (only reads the JSON knowledge store). Solid edge on a `file#name` key match; dashed
 *  (`inferred`) on a line-overlap-only match (e.g. a mined incident with a line but no symbol key). */
async function linkSymbolIncidents(
  out: { nodes: VizNode[]; edges: VizEdge[] },
  fileId: string,
  syms: SymbolDesc[],
  knowledgeDir: string,
): Promise<void> {
  if (syms.length === 0) return;
  let incidents: Incident[];
  try {
    incidents = (await new KnowledgeStore(knowledgeDir).incidents()).filter((i) => i.file === fileId);
  } catch {
    return; // knowledge store unreadable — the code-graph expand still stands
  }
  if (incidents.length === 0) return;
  const emitted = new Set<string>();
  for (const s of syms) {
    const key = symbolKey(fileId, s.name);
    const hits = incidents
      .filter((i) => (i.symbol && i.symbol === key) || (i.line != null && i.line >= s.startLine && i.line <= s.endLine))
      .slice(0, 8); // a busy symbol shouldn't fan out unboundedly
    for (const i of hits) {
      const incId = `inc:${i.id}`;
      if (!emitted.has(incId)) {
        emitted.add(incId);
        out.nodes.push(incidentVizNode(i));
      }
      const keyed = i.symbol === key; // solid when keyed to this symbol; dashed when only line falls inside
      out.edges.push({
        id: `concerns|${s.nodeId}|${i.id}`,
        source: s.nodeId,
        target: incId,
        label: 'concerns',
        graph: 'code',
        ...(keyed ? {} : { inferred: true }),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// PR brain: Round / Finding / Verdict / Comment around a per-target hub.
// The brain has no rel tables (ADR-30) — edges are synthesized from the
// `target` / `round` / `findingId` string keys the nodes carry.
// ---------------------------------------------------------------------------

export async function collectBrain(repo: RepoEntry, cap = DEFAULT_NODE_CAP): Promise<GraphPayload> {
  // The brain is now the durable JSONL lineage layer (ADR-46) — one file per review target under the
  // BASE repo's `lineage/` dir. We fold each file with the SAME `@plex/core` fold the engine uses, so
  // the viz and the review loop agree on outcome-stickiness etc. No Kùzu, so no lock / 503 here.
  if (!repo.hasLineage || !existsSync(repo.lineageDir)) {
    return emptyPayload('brain', 'No review history yet — it accrues durably (per PR/branch) as Plex reviews this repo.');
  }
  let files: string[];
  try {
    files = readdirSync(repo.lineageDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return emptyPayload('brain', 'No review history yet.');
  }

  const nodes: VizNode[] = [];
  const edges: VizEdge[] = [];
  const targets = new Set<string>();
  const addedFindingIds = new Set<string>(); // finding ids actually rendered (within the cap)
  const hubId = (t: string): string => `t:${t}`;
  const ensureHub = (t: string): void => {
    if (!t || targets.has(t)) return;
    targets.add(t);
    nodes.push({ id: hubId(t), label: t, type: 'Target', graph: 'brain', props: { target: t } });
  };

  let totalFindings = 0;
  let findingBudget = cap;
  for (const f of files) {
    let events;
    try {
      events = parseLineageEvents(readFileSync(join(repo.lineageDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (events.length === 0) continue;
    const t = events[0]!.target; // one target per file
    const view = foldLineage(events);
    ensureHub(t);

    const roundNodeByN = new Map<number, string>();
    for (const r of view.rounds) {
      const id = `r:${t}#${r.n}`;
      roundNodeByN.set(r.n, id);
      nodes.push({ id, label: `round ${r.n}`, type: 'Round', graph: 'brain', props: { target: t, n: r.n, ts: r.ts, headSha: r.headSha.slice(0, 12), baseRef: r.baseRef } });
      edges.push({ id: `r-t|${id}`, source: id, target: hubId(t), label: 'round of', graph: 'brain' });
    }

    const findingLocs: Array<{ nodeId: string; file: string; line: number }> = [];
    totalFindings += view.findings.length;
    for (const fi of view.findings) {
      if (findingBudget <= 0) break;
      findingBudget -= 1;
      const id = `fi:${fi.id}`;
      addedFindingIds.add(fi.id);
      findingLocs.push({ nodeId: id, file: fi.file, line: fi.line });
      nodes.push({
        id, label: fi.title, type: 'Finding', graph: 'brain',
        props: {
          severity: fi.severity, confidence: fi.confidence, source: fi.source,
          file: fi.file, line: fi.line, triage: fi.triage,
          outcome: view.outcomeOf(fi.id) || 'open', round: fi.round,
        },
      });
      const round = roundNodeByN.get(fi.round);
      edges.push({ id: `fi-r|${fi.id}`, source: id, target: round ?? hubId(t), label: 'raised in', graph: 'brain' });
    }

    for (const v of view.verdicts) {
      const id = `v:${t}#${v.findingId}`;
      nodes.push({ id, label: v.kind, type: 'Verdict', graph: 'brain', props: { kind: v.kind, scope: v.scope, ts: v.ts, title: v.title, findingId: v.findingId } });
      const fnode = addedFindingIds.has(v.findingId) ? `fi:${v.findingId}` : hubId(t);
      edges.push({ id: `v-fi|${id}`, source: id, target: fnode, label: 'verdict on', graph: 'brain' });
    }

    for (const c of view.comments) {
      const id = `c:${c.id}`;
      const body = c.body;
      nodes.push({ id, label: body.length > 40 ? body.slice(0, 40) + '…' : body, type: 'Comment', graph: 'brain', props: { body, author: c.author, file: c.file, line: c.line } });
      // Same-file, line-window locality → the "this comment ↔ this finding" hop (no stored edge);
      // fall back to the target hub when nothing matches, so the comment stays connected.
      const near = c.file
        ? findingLocs.filter((fl) => fl.file === c.file && (c.line <= 0 || fl.line <= 0 || Math.abs(fl.line - c.line) <= COMMENT_LINK_WINDOW)).slice(0, 5)
        : [];
      if (near.length) {
        for (const m of near) edges.push({ id: `c-fi|${c.id}|${m.nodeId}`, source: id, target: m.nodeId, label: 'comment on', graph: 'brain' });
      } else {
        edges.push({ id: `c-t|${c.id}`, source: id, target: hubId(t), label: 'comment', graph: 'brain' });
      }
    }
  }

  const truncated = totalFindings > cap;
  const note = truncated ? `Showing ${cap} of ${totalFindings} findings (capped).` : undefined;
  return withCounts({ graph: 'brain', nodes, edges, truncated, counts: {}, note });
}

// ---------------------------------------------------------------------------
// Knowledge base: Pitfall -> Incident provenance (JSON store, no Kùzu).
// ---------------------------------------------------------------------------

export async function collectKnowledge(
  knowledgeDir: string,
  opts: { repo?: string; cap?: number } = {},
): Promise<GraphPayload> {
  const cap = opts.cap ?? DEFAULT_NODE_CAP * 3;
  const store = new KnowledgeStore(knowledgeDir);
  let pitfalls = await store.pitfalls();
  let incidents = await store.incidents();
  // Repo-scope (the picker's selected repo): an EXPLORER scopes by ORIGIN — "what did we learn from
  // THIS repo" — i.e. the `repo` tag, regardless of a pitfall's apply-everywhere scope (ADR-21 scoping
  // is a retrieval concern; here the user is inspecting provenance). Keep this repo's pitfalls + the
  // incidents they cite + any incident tagged with this repo. The store holds the repo *name*
  // (basename), which is what the registry carries. (No repo arg → the whole global base.)
  if (opts.repo) {
    pitfalls = pitfalls.filter((p) => (p.repo ?? '') === opts.repo);
    const cited = new Set(pitfalls.flatMap((p) => p.incidentIds ?? []));
    incidents = incidents.filter((i) => (i.repo ?? '') === opts.repo || cited.has(i.id));
  }
  if (pitfalls.length === 0 && incidents.length === 0) {
    return emptyPayload(
      'knowledge',
      opts.repo
        ? `No learned pitfalls scoped to ${opts.repo} yet.`
        : 'No learned pitfalls yet — they accrue from `plex analyze` and accepted findings.',
    );
  }
  const nodes: VizNode[] = [];
  const edges: VizEdge[] = [];
  const incidentById = new Map<string, Incident>();
  for (const i of incidents) incidentById.set(i.id, i);
  const emitted = new Set<string>();

  const incidentNode = (i: Incident): void => {
    const id = `inc:${i.id}`;
    if (emitted.has(id)) return;
    emitted.add(id);
    nodes.push(incidentVizNode(i));
  };

  for (const p of pitfalls.slice(0, cap)) {
    const id = `pf:${p.id}`;
    nodes.push({
      id, label: p.title, type: p.polarity === 'negative' ? 'Suppression' : 'Pitfall', graph: 'knowledge',
      props: pitfallProps(p),
    });
    for (const incId of p.incidentIds ?? []) {
      const inc = incidentById.get(incId);
      if (inc) {
        incidentNode(inc);
        edges.push({ id: `pf-inc|${p.id}|${incId}`, source: id, target: `inc:${incId}`, label: 'from', graph: 'knowledge' });
      }
    }
  }
  // Incidents that reference a pitfall by id but weren't reached above (orphan provenance) — show them
  // linked too, so the provenance view is complete rather than silently dropping back-references.
  for (const i of incidents) {
    if (i.pitfallId && emitted.has(`pf:${i.pitfallId}`) === false && nodes.some((n) => n.id === `pf:${i.pitfallId}`)) {
      incidentNode(i);
      edges.push({ id: `inc-pf|${i.id}`, source: `inc:${i.id}`, target: `pf:${i.pitfallId}`, label: 'about', graph: 'knowledge' });
    }
  }

  const truncated = pitfalls.length > cap;
  const note = truncated ? `Showing ${cap} of ${pitfalls.length} pitfalls (capped).` : undefined;
  return withCounts({ graph: 'knowledge', nodes, edges, truncated, counts: {}, note });
}

// ---------------------------------------------------------------------------
// Lineage: brain ⨝ knowledge — the comment → finding → verdict → incident → pitfall chain.
// Tier 1 (ADR-45/M13): the finding→incident hop is an INFERRED same-file bridge (dashed), because
// an Incident carries no recorded back-reference to its Finding yet. Tier 2 (the durable lineage
// journal) replaces those with exact edges. The brain-internal chain (comment→finding→verdict→round)
// and the knowledge provenance (incident→pitfall) are REAL edges from the stores.
// ---------------------------------------------------------------------------

/**
 * Pure: merge a brain payload and a (repo-scoped) knowledge payload, adding heuristic same-file
 * bridge edges from each accepted/fixed Finding to Incidents in the same file. Unit-tested without
 * Kùzu. Bridges are flagged `inferred` (drawn dashed) and capped per finding so a busy file can't
 * fan out unboundedly.
 */
export function linkLineage(brain: GraphPayload, knowledge: GraphPayload): GraphPayload {
  const incidentsByFile = new Map<string, VizNode[]>();
  for (const n of knowledge.nodes) {
    if (n.type !== 'Incident') continue;
    const f = String(n.props.file ?? '');
    if (!f) continue;
    const list = incidentsByFile.get(f);
    if (list) list.push(n);
    else incidentsByFile.set(f, [n]);
  }
  const brainFindingIds = new Set(brain.nodes.filter((n) => n.type === 'Finding').map((n) => n.id));
  const bridges: VizEdge[] = [];

  // RECORDED edges (ADR-46 increment 1): an Incident that carries `findingId` links to the exact brain
  // Finding it was confirmed from — a solid, true provenance edge. Preferred over the inferred bridge.
  const recorded = new Set<string>();
  for (const inc of knowledge.nodes) {
    if (inc.type !== 'Incident') continue;
    const fid = String(inc.props.findingId ?? '');
    if (!fid) continue;
    const fnode = `fi:${fid}`;
    if (!brainFindingIds.has(fnode)) continue;
    bridges.push({ id: `prov|${fnode}|${inc.id}`, source: fnode, target: inc.id, label: 'became', graph: 'lineage' });
    recorded.add(fnode);
  }

  // INFERRED bridge (fallback only): an accepted/fixed finding with NO recorded link, matched to
  // same-file incidents. Dashed; shrinks as new accepts carry `findingId`.
  let inferred = 0;
  for (const n of brain.nodes) {
    if (n.type !== 'Finding' || recorded.has(n.id)) continue;
    const outcome = String(n.props.outcome ?? '');
    if (outcome !== 'accepted' && outcome !== 'fixed') continue;
    const incs = incidentsByFile.get(String(n.props.file ?? ''));
    if (!incs) continue;
    for (const inc of incs.slice(0, 8)) {
      bridges.push({ id: `bridge|${n.id}|${inc.id}`, source: n.id, target: inc.id, label: 'likely became', graph: 'lineage', inferred: true });
      inferred += 1;
    }
  }
  const nodes = [...brain.nodes, ...knowledge.nodes];
  const edges = [...brain.edges, ...knowledge.edges, ...bridges];
  const counts: Record<string, number> = {};
  for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
  const note = brain.nodes.length === 0
    ? 'No PR brain for this repo (reviews may have run from worktrees) — durable lessons are under Knowledge.'
    : `${recorded.size} recorded finding→incident link(s)` +
      (inferred ? ` + ${inferred} inferred (dashed, same-file — exact links arrive as more accepts carry provenance)` : '') +
      (recorded.size === 0 && inferred === 0 ? ' — no accepted finding linked to a stored incident yet' : '') + '.';
  return { graph: 'lineage', nodes, edges, truncated: brain.truncated || knowledge.truncated, counts, note };
}

/** The lineage view for a repo: its brain chain ⨝ its repo-scoped knowledge (one Kùzu open via collectBrain). */
export async function collectLineage(repo: RepoEntry, knowledgeDir: string): Promise<GraphPayload> {
  const brain = await collectBrain(repo);
  const knowledge = await collectKnowledge(knowledgeDir, { repo: repo.name });
  return linkLineage(brain, knowledge);
}

/** Pitfall fields for the panel — never the embedding vector (huge + useless to a human). */
function pitfallProps(p: Pitfall): Record<string, string | number | boolean> {
  return {
    category: p.category,
    polarity: p.polarity ?? 'positive',
    confidence: Number(p.confidence.toFixed(3)),
    scope: p.scope ?? 'global',
    repo: p.repo ?? '',
    language: p.language ?? '',
    tier: p.tier,
    trigger: p.trigger,
    why: p.why,
    mitigation: p.mitigation ?? '',
    suppressKey: p.suppressKey ?? '',
    incidents: (p.incidentIds ?? []).length,
    lastReinforcedAt: p.lastReinforcedAt ?? '',
  };
}
