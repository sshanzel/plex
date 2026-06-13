import { existsSync } from 'node:fs';
import { CodeGraphDB } from '@plex/code-graph';
import { KnowledgeStore } from '@plex/knowledge';
import type { Pitfall, Incident } from '@plex/core';
import { type GraphPayload, type VizEdge, type VizNode, emptyPayload, withCounts } from './model';
import type { RepoEntry } from './registry';

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown): number => Number(v) || 0;

/** Per-graph node cap — keeps a huge monorepo's payload (and the browser) responsive. Hitting it
 *  sets `truncated`, which the UI surfaces, so a partial graph never silently reads as complete. */
const DEFAULT_NODE_CAP = 800;

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

/** Expand one File: its symbols (+ Declares edges) and immediate file neighbors, for click-to-walk. */
export async function expandCodeFile(repo: RepoEntry, fileId: string): Promise<{ nodes: VizNode[]; edges: VizEdge[] }> {
  if (!repo.hasGraph || !existsSync(repo.graphDir)) return { nodes: [], edges: [] };
  return withGraph(repo.graphDir, async (db) => {
    const nodes: VizNode[] = [];
    const edges: VizEdge[] = [];
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
    return { nodes, edges };
  });
}

// ---------------------------------------------------------------------------
// PR brain: Round / Finding / Verdict / Comment around a per-target hub.
// The brain has no rel tables (ADR-30) — edges are synthesized from the
// `target` / `round` / `findingId` string keys the nodes carry.
// ---------------------------------------------------------------------------

export async function collectBrain(repo: RepoEntry, cap = DEFAULT_NODE_CAP): Promise<GraphPayload> {
  if (!repo.hasBrain || !existsSync(repo.brainDir)) {
    return emptyPayload('brain', 'No PR brain yet — it fills in as Plex reviews this repo.');
  }
  return withGraph(repo.brainDir, async (db) => {
    const nodes: VizNode[] = [];
    const edges: VizEdge[] = [];
    const targets = new Set<string>();
    const roundIdByKey = new Map<string, string>(); // `${target}#${n}` -> node id

    const hubId = (t: string): string => `t:${t}`;
    const ensureHub = (t: string): void => {
      if (!t || targets.has(t)) return;
      targets.add(t);
      nodes.push({ id: hubId(t), label: t, type: 'Target', graph: 'brain', props: { target: t } });
    };

    const rounds = await db.run('MATCH (r:Round) RETURN r.id AS id, r.target AS target, r.n AS n, r.ts AS ts, r.headSha AS headSha, r.baseRef AS baseRef ORDER BY r.target, r.n');
    for (const r of rounds) {
      const t = str(r.target);
      ensureHub(t);
      const id = `r:${str(r.id)}`;
      roundIdByKey.set(`${t}#${num(r.n)}`, id);
      nodes.push({
        id,
        label: `round ${num(r.n)}`,
        type: 'Round',
        graph: 'brain',
        props: { target: t, n: num(r.n), ts: str(r.ts), headSha: str(r.headSha).slice(0, 12), baseRef: str(r.baseRef) },
      });
      edges.push({ id: `r-t|${str(r.id)}`, source: id, target: hubId(t), label: 'round of', graph: 'brain' });
    }

    const findings = await db.run('MATCH (fi:Finding) RETURN fi.id AS id, fi.target AS target, fi.title AS title, fi.severity AS severity, fi.confidence AS confidence, fi.source AS source, fi.file AS file, fi.line AS line, fi.triage AS triage, fi.outcome AS outcome, fi.round AS round');
    const findingNodeId = new Map<string, string>(); // brain finding id -> node id
    for (const r of findings.slice(0, cap)) {
      const t = str(r.target);
      ensureHub(t);
      const fid = str(r.id);
      const id = `fi:${fid}`;
      findingNodeId.set(fid, id);
      nodes.push({
        id,
        label: str(r.title),
        type: 'Finding',
        graph: 'brain',
        props: {
          severity: str(r.severity), confidence: num(r.confidence), source: str(r.source),
          file: str(r.file), line: num(r.line), triage: str(r.triage),
          outcome: str(r.outcome) || 'open', round: num(r.round),
        },
      });
      // Attach to the round it was last raised in (fallback: the hub) so the graph stays connected.
      const round = roundIdByKey.get(`${t}#${num(r.round)}`);
      edges.push({ id: `fi-r|${fid}`, source: id, target: round ?? hubId(t), label: 'raised in', graph: 'brain' });
    }

    for (const r of await db.run('MATCH (v:Verdict) RETURN v.id AS id, v.target AS target, v.findingId AS findingId, v.kind AS kind, v.scope AS scope, v.ts AS ts, v.title AS title')) {
      const t = str(r.target);
      ensureHub(t);
      const id = `v:${str(r.id)}`;
      nodes.push({
        id, label: str(r.kind), type: 'Verdict', graph: 'brain',
        props: { kind: str(r.kind), scope: str(r.scope), ts: str(r.ts), title: str(r.title), findingId: str(r.findingId) },
      });
      const fnode = findingNodeId.get(str(r.findingId));
      edges.push({ id: `v-fi|${str(r.id)}`, source: id, target: fnode ?? hubId(t), label: 'verdict on', graph: 'brain' });
    }

    for (const r of await db.run('MATCH (c:Comment) RETURN c.id AS id, c.target AS target, c.body AS body, c.author AS author, c.file AS file, c.line AS line')) {
      const t = str(r.target);
      ensureHub(t);
      const id = `c:${str(r.id)}`;
      const body = str(r.body);
      nodes.push({
        id, label: body.length > 40 ? body.slice(0, 40) + '…' : body, type: 'Comment', graph: 'brain',
        props: { body, author: str(r.author), file: str(r.file), line: num(r.line) },
      });
      edges.push({ id: `c-t|${str(r.id)}`, source: id, target: hubId(t), label: 'comment', graph: 'brain' });
    }

    const truncated = findings.length > cap;
    const note = truncated ? `Showing ${cap} of ${findings.length} findings (capped).` : undefined;
    return withCounts({ graph: 'brain', nodes, edges, truncated, counts: {}, note });
  });
}

// ---------------------------------------------------------------------------
// Knowledge base: Pitfall -> Incident provenance (JSON store, no Kùzu).
// ---------------------------------------------------------------------------

export async function collectKnowledge(knowledgeDir: string, cap = DEFAULT_NODE_CAP * 3): Promise<GraphPayload> {
  const store = new KnowledgeStore(knowledgeDir);
  const pitfalls = await store.pitfalls();
  const incidents = await store.incidents();
  if (pitfalls.length === 0 && incidents.length === 0) {
    return emptyPayload('knowledge', 'No learned pitfalls yet — they accrue from `plex analyze` and accepted findings.');
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
    nodes.push({
      id, label: i.note || i.file || i.id, type: 'Incident', graph: 'knowledge',
      props: {
        source: i.source, outcome: i.outcome ?? '', repo: i.repo ?? '', file: i.file ?? '',
        verb: i.verb ?? '', ts: i.ts, snippet: (i.snippet ?? '').slice(0, 200),
      },
    });
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
