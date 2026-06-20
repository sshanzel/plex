import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodeGraphDB } from '@plex/code-graph';
import { KnowledgeStore, buildKnowledgeGraph, concernsAt, concernsInFile } from '@plex/knowledge';
import { foldLineage, parseLineageEvents, symbolKey, type Pitfall, type Incident } from '@plex/core';
import { type GraphPayload, type VizEdge, type VizNode, emptyPayload, withCounts } from './model';
import type { RepoEntry } from './registry';

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown): number => Number(v) || 0;

/** The Incident viz node — shared by the knowledge graph and the symbol↔incident join (same id → dedups). */
function incidentVizNode(i: Incident): VizNode {
  return {
    id: `inc:${i.id}`,
    label: i.note || i.file || i.id,
    type: 'Incident',
    graph: 'knowledge',
    props: {
      source: i.source, outcome: i.outcome ?? '', repo: i.repo ?? '', file: i.file ?? '',
      symbol: i.symbol ?? '', line: i.line ?? -1,
      verb: i.verb ?? '', ts: i.ts, snippet: (i.snippet ?? '').slice(0, 200),
      // Tier-2 provenance (ADR-46): the review event this came from — drives a recorded lineage edge.
      findingId: i.findingId ?? '', target: i.target ?? '',
    },
  };
}

/** Per-graph node cap — keeps the payload responsive; hitting it sets `truncated` (surfaced in the UI). */
const DEFAULT_NODE_CAP = 800;

/** Code-graph LANDING size for a big repo: show the most-CONNECTED files, not the first N. */
const CODE_LANDING_CAP = 80;

/** Line window for the locality-based comment→finding link (the brain stores no explicit edge). */
const COMMENT_LINK_WINDOW = 25;

/** Open Kùzu, run `fn`, ALWAYS close — the daemon must NEVER hold a handle across requests (Kùzu is
 *  single-writer; a held lock breaks a concurrent review with RepoBusyError → 503, ADR-45). */
async function withGraph<T>(dir: string, fn: (db: CodeGraphDB) => Promise<T>): Promise<T> {
  const db = new CodeGraphDB(dir);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

export async function collectCode(repo: RepoEntry, cap = DEFAULT_NODE_CAP): Promise<GraphPayload> {
  if (!repo.hasGraph || !existsSync(repo.graphDir)) {
    return emptyPayload('code', 'This repo has no code graph yet — run `plex index`.');
  }
  return withGraph(repo.graphDir, async (db) => {
    const files = await db.run('MATCH (f:File) RETURN f.id AS id, f.path AS path, f.lang AS lang');

    // Pull coupling edges first so we can rank files by DEGREE and land on the hubs, not an arbitrary slice.
    const rawEdges: { s: string; t: string; label: string; undirected: boolean }[] = [];
    for (const r of await db.run('MATCH (a:File)-[:Imports]->(b:File) RETURN a.id AS s, b.id AS t')) {
      rawEdges.push({ s: str(r.s), t: str(r.t), label: 'import', undirected: false });
    }
    for (const r of await db.run('MATCH (a:File)-[:Refs]->(b:File) RETURN a.id AS s, b.id AS t')) {
      rawEdges.push({ s: str(r.s), t: str(r.t), label: 'ref', undirected: false });
    }
    for (const r of await db.run('MATCH (a:File)-[c:CoChange]->(b:File) RETURN a.id AS s, b.id AS t')) {
      rawEdges.push({ s: str(r.s), t: str(r.t), label: 'co-change', undirected: true });
    }
    const degree = new Map<string, number>();
    const adj = new Map<string, Set<string>>();
    for (const e of rawEdges) {
      if (e.s === e.t) continue;
      degree.set(e.s, (degree.get(e.s) ?? 0) + 1);
      degree.set(e.t, (degree.get(e.t) ?? 0) + 1);
      (adj.get(e.s) ?? adj.set(e.s, new Set()).get(e.s)!).add(e.t);
      (adj.get(e.t) ?? adj.set(e.t, new Set()).get(e.t)!).add(e.s);
    }

    // Small repo shows in full; a large one grows a CONNECTED neighbourhood (each hub + its neighbours)
    // so the landing shows real coupling structure, not isolated dots. Rest reachable via search/expand.
    const landing = files.length > CODE_LANDING_CAP;
    let included: Set<string>;
    if (!landing) {
      included = new Set(files.map((r) => str(r.id)));
    } else {
      included = new Set<string>();
      const ranked = [...files].sort((a, b) => (degree.get(str(b.id)) ?? 0) - (degree.get(str(a.id)) ?? 0));
      for (const f of ranked) {
        if (included.size >= CODE_LANDING_CAP) break;
        const fid = str(f.id);
        if (included.has(fid)) continue;
        const nbs = [...(adj.get(fid) ?? [])];
        // A hub with neighbours needs room for at least one — never land it as the last node (isolated dot).
        if (nbs.length > 0 && included.size >= CODE_LANDING_CAP - 1) continue;
        included.add(fid);
        for (const nb of nbs) {
          if (included.size >= CODE_LANDING_CAP) break;
          included.add(nb);
        }
      }
    }
    const slice = files.filter((r) => included.has(str(r.id)));

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
    for (const e of rawEdges) addEdge(e.s, e.t, e.label, e.undirected);

    // Only claim "most-connected" when there ARE edges to rank by; an edgeless graph just shows first N.
    const note = !landing
      ? undefined
      : rawEdges.length === 0
        ? `Showing ${slice.length} of ${files.length} files (no import/co-change edges indexed yet) — search to load any file.`
        : `Showing the ${slice.length} most-connected files of ${files.length} — double-click a file to expand its neighbours, or search to load any file.`;
    return withCounts({ graph: 'code', nodes, edges, truncated: landing, counts: {}, note });
  });
}

/** Find File nodes whose path matches `query` (reaches files outside the landing set). Parameterized
 *  (`$q`) — user input must NEVER be string-concatenated into Cypher (security posture). */
export async function searchFiles(repo: RepoEntry, query: string, limit = 40): Promise<VizNode[]> {
  const q = query.trim().toLowerCase();
  if (!q || !repo.hasGraph || !existsSync(repo.graphDir)) return [];
  return withGraph(repo.graphDir, async (db) => {
    const rows = await db.run(
      'MATCH (f:File) WHERE toLower(f.path) CONTAINS $q RETURN f.id AS id, f.path AS path, f.lang AS lang LIMIT $lim',
      { q, lim: limit },
    );
    const symCounts = new Map<string, number>();
    for (const r of await db.run('MATCH (s:Symbol) RETURN s.file AS file, count(s) AS c')) {
      symCounts.set(str(r.file), num(r.c));
    }
    return rows.map((r): VizNode => {
      const id = str(r.id);
      return { id: `f:${id}`, label: id, type: 'File', graph: 'code', props: { path: str(r.path) || id, lang: str(r.lang), symbols: symCounts.get(id) ?? 0 } };
    });
  });
}

interface SymbolDesc {
  nodeId: string;
  name: string;
  startLine: number;
  endLine: number;
}

/** Expand one File: its symbols (+ Declares edges), immediate file neighbors, and — when a knowledge
 *  dir is given — the recorded concerns anchored at each symbol (code-path memory, ADR-47). */
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
  // Symbol↔incident join — runs AFTER the Kùzu handle is closed (no held lock).
  if (knowledgeDir) await linkSymbolIncidents({ nodes, edges }, fileId, syms, knowledgeDir);
  return { nodes, edges };
}

/** Per symbol, add Incident nodes + `concerns` edges: solid on a `file#name` key match, dashed
 *  (`inferred`) on a line-overlap-only match. Reads only the JSON knowledge store. */
async function linkSymbolIncidents(
  out: { nodes: VizNode[]; edges: VizEdge[] },
  fileId: string,
  syms: SymbolDesc[],
  knowledgeDir: string,
): Promise<void> {
  if (syms.length === 0) return;
  let graph;
  try {
    graph = buildKnowledgeGraph([], await new KnowledgeStore(knowledgeDir).incidents());
  } catch {
    return; // knowledge store unreadable — the code-graph expand still stands
  }
  const inFile = concernsInFile(graph, fileId);
  if (inFile.length === 0) return;
  const emitted = new Set<string>();
  for (const s of syms) {
    const key = symbolKey(fileId, s.name);
    const keyed = new Set(concernsAt(graph, key).map((i) => i.id)); // exact symbol-key matches (solid edges)
    const hits = inFile
      // exact key (solid) OR line-in-span for a key-LESS incident (dashed). An incident keyed to a
      // DIFFERENT symbol must not drift here on line alone.
      .filter((i) => keyed.has(i.id) || (!i.symbol && i.line != null && i.line >= s.startLine && i.line <= s.endLine))
      .slice(0, 8); // cap fan-out for a busy symbol
    for (const i of hits) {
      const incId = `inc:${i.id}`;
      if (!emitted.has(incId)) {
        emitted.add(incId);
        out.nodes.push(incidentVizNode(i));
      }
      const isKeyed = keyed.has(i.id);
      out.edges.push({
        id: `concerns|${s.nodeId}|${i.id}`,
        source: s.nodeId,
        target: incId,
        label: 'concerns',
        graph: 'code',
        ...(isKeyed ? {} : { inferred: true }),
      });
    }
  }
}

// PR brain: Round / Finding / Verdict / Comment around a per-target hub. Edges are synthesized from
// the `target` / `round` / `findingId` string keys the nodes carry (the brain has no rel tables, ADR-30).
export async function collectBrain(repo: RepoEntry, cap = DEFAULT_NODE_CAP): Promise<GraphPayload> {
  // Durable JSONL lineage layer (ADR-46) — folded with the SAME `@plex/core` fold the engine uses, so
  // the viz and the review loop agree on outcome-stickiness. No Kùzu, so no lock / 503 here.
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
  const addedFindingIds = new Set<string>(); // finding ids rendered within the cap
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
      // Same-file, line-window locality → the comment↔finding hop (no stored edge); fall back to the hub.
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

// Knowledge base: Pitfall -> Incident provenance (JSON store, no Kùzu).
export async function collectKnowledge(
  knowledgeDir: string,
  opts: { repo?: string; cap?: number } = {},
): Promise<GraphPayload> {
  const cap = opts.cap ?? DEFAULT_NODE_CAP * 3;
  const store = new KnowledgeStore(knowledgeDir);
  let pitfalls = await store.pitfalls();
  let incidents = await store.incidents();
  // Repo-scope is by ORIGIN (the `repo` tag — "what we learned from THIS repo"), not a pitfall's
  // apply-everywhere scope: an explorer inspects provenance (ADR-21 scoping is a retrieval concern).
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

  const pitfallSlice = pitfalls.slice(0, cap);
  const pitfallNodeIds = new Set(pitfallSlice.map((p) => `pf:${p.id}`));
  for (const p of pitfallSlice) {
    nodes.push({
      id: `pf:${p.id}`, label: p.title, type: p.polarity === 'negative' ? 'Suppression' : 'Pitfall', graph: 'knowledge',
      props: pitfallProps(p),
    });
  }

  // Each incident nests inside ONE container — the first pitfall that cites/references it (Cytoscape
  // compound nodes have a single parent). A second pitfall keeps a cross-cluster `from`/`about` edge.
  const parentOf = new Map<string, string>();
  for (const p of pitfallSlice) {
    for (const incId of p.incidentIds ?? []) {
      if (incidentById.has(incId) && !parentOf.has(incId)) parentOf.set(incId, `pf:${p.id}`);
    }
  }
  for (const i of incidents) {
    if (i.pitfallId && pitfallNodeIds.has(`pf:${i.pitfallId}`) && !parentOf.has(i.id)) parentOf.set(i.id, `pf:${i.pitfallId}`);
  }

  const incidentNode = (i: Incident): void => {
    const id = `inc:${i.id}`;
    if (emitted.has(id)) return;
    emitted.add(id);
    const node = incidentVizNode(i);
    const parent = parentOf.get(i.id);
    if (parent) node.parent = parent;
    nodes.push(node);
  };

  const crossLinked = new Set<string>(); // `${pitfallId}|${incidentId}` pairs drawn cross-cluster
  for (const p of pitfallSlice) {
    for (const incId of p.incidentIds ?? []) {
      if (!incidentById.has(incId)) continue;
      incidentNode(incidentById.get(incId)!);
      // Containment expresses the primary `from`; only draw an edge when THIS pitfall isn't the container.
      if (parentOf.get(incId) !== `pf:${p.id}`) {
        edges.push({ id: `pf-inc|${p.id}|${incId}`, source: `pf:${p.id}`, target: `inc:${incId}`, label: 'from', graph: 'knowledge' });
        crossLinked.add(`${p.id}|${incId}`);
      }
    }
  }
  // Incidents that reference a pitfall by id — nested when it's their container, else a cross-cluster
  // `about` edge. Skip when a `from` edge already links this exact (pitfall, incident) pair.
  for (const i of incidents) {
    if (i.pitfallId && pitfallNodeIds.has(`pf:${i.pitfallId}`)) {
      incidentNode(i);
      if (parentOf.get(i.id) !== `pf:${i.pitfallId}` && !crossLinked.has(`${i.pitfallId}|${i.id}`)) {
        edges.push({ id: `inc-pf|${i.id}`, source: `inc:${i.id}`, target: `pf:${i.pitfallId}`, label: 'about', graph: 'knowledge' });
      }
    }
  }

  const truncated = pitfalls.length > cap;
  const note = truncated ? `Showing ${cap} of ${pitfalls.length} pitfalls (capped).` : undefined;
  return withCounts({ graph: 'knowledge', nodes, edges, truncated, counts: {}, note });
}

// Lineage (ADR-45/M13): brain ⨝ knowledge — comment → finding → verdict → incident → pitfall. The
// finding→incident hop is RECORDED when an Incident carries `findingId`, else an INFERRED same-file
// bridge (dashed); the brain-internal chain and the incident→pitfall provenance are REAL store edges.

/** Pure: merge a brain payload and a repo-scoped knowledge payload, adding heuristic same-file bridge
 *  edges from each accepted/fixed Finding to same-file Incidents (flagged `inferred`, capped per finding). */
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

  // RECORDED edges (ADR-46): an Incident carrying `findingId` links to the exact Finding (solid). Preferred.
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

  // INFERRED bridge (fallback): an accepted/fixed finding with NO recorded link → same-file incidents (dashed).
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

/** The lineage view for a repo: its brain chain ⨝ its repo-scoped knowledge. */
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
