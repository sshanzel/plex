import type { CodeGraphDB } from './db';

export interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface CoChangeEdge {
  src: string;
  dst: string;
  weight: number;
  cnt: number;
}

export async function getSymbolsInFile(db: CodeGraphDB, file: string): Promise<SymbolRow[]> {
  const rows = await db.run(
    'MATCH (s:Symbol {file:$file}) RETURN s.id AS id, s.name AS name, s.kind AS kind, s.startLine AS startLine, s.endLine AS endLine',
    { file },
  );
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    kind: String(r.kind),
    startLine: Number(r.startLine),
    endLine: Number(r.endLine),
  }));
}

/** Co-change neighbors of any file in `ids` (undirected). */
export async function getCoChangeEdges(db: CodeGraphDB, ids: string[]): Promise<CoChangeEdge[]> {
  if (ids.length === 0) return [];
  const rows = await db.run(
    'MATCH (a:File)-[c:CoChange]-(b:File) WHERE a.id IN $ids RETURN a.id AS src, b.id AS dst, c.weight AS weight, c.cnt AS cnt',
    { ids },
  );
  return rows.map((r) => ({
    src: String(r.src),
    dst: String(r.dst),
    weight: Number(r.weight),
    cnt: Number(r.cnt),
  }));
}

/** Co-change degree per file — sum of incident CoChange edge weights; normalizes pair strength into association strength (tuning.md §4). */
export async function getCoChangeDegrees(db: CodeGraphDB, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db.run(
    'MATCH (a:File)-[c:CoChange]-(b:File) WHERE a.id IN $ids RETURN a.id AS id, sum(c.weight) AS deg',
    { ids },
  );
  const m = new Map<string, number>();
  for (const r of rows) m.set(String(r.id), Number(r.deg) || 0);
  return m;
}

/**
 * Total coupling degree per file — count of incident File↔File edges (CoChange ∪ Imports ∪ Refs,
 * enumerated explicitly: CoChangePending is a staging lane reads must never count). Proxy for how widely depended-on a file is.
 */
export async function getCouplingDegrees(db: CodeGraphDB, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db.run(
    'MATCH (a:File)-[r:CoChange|Imports|Refs]-(b:File) WHERE a.id IN $ids RETURN a.id AS id, count(r) AS deg',
    { ids },
  );
  const m = new Map<string, number>();
  for (const r of rows) m.set(String(r.id), Number(r.deg) || 0);
  return m;
}

/** Import neighbors of any file in `ids` (undirected: importers and imported). */
export async function getImportEdges(
  db: CodeGraphDB,
  ids: string[],
): Promise<{ src: string; dst: string }[]> {
  if (ids.length === 0) return [];
  const rows = await db.run(
    'MATCH (a:File)-[:Imports]-(b:File) WHERE a.id IN $ids RETURN a.id AS src, b.id AS dst',
    { ids },
  );
  return rows.map((r) => ({ src: String(r.src), dst: String(r.dst) }));
}

/** Precise (alias-aware) reference neighbors of any file in `ids` (undirected). */
export async function getRefEdges(
  db: CodeGraphDB,
  ids: string[],
): Promise<{ src: string; dst: string }[]> {
  if (ids.length === 0) return [];
  const rows = await db.run(
    'MATCH (a:File)-[:Refs]-(b:File) WHERE a.id IN $ids RETURN a.id AS src, b.id AS dst',
    { ids },
  );
  return rows.map((r) => ({ src: String(r.src), dst: String(r.dst) }));
}

/**
 * Identify barrel / re-export files (ADR-06 refinement) — heuristic, no type checker: zero own symbols
 * yet import degree ≥ `minImportDegree`. The blast-radius walk treats these as transparent (pass coupling through).
 */
export async function getBarrelFiles(db: CodeGraphDB, minImportDegree = 3): Promise<Set<string>> {
  const symCount = new Map<string, number>();
  for (const r of await db.run('MATCH (s:Symbol) RETURN s.file AS file, count(s) AS c')) {
    symCount.set(String(r.file), Number(r.c) || 0);
  }
  const barrels = new Set<string>();
  for (const r of await db.run('MATCH (f:File)-[i:Imports]-(:File) RETURN f.id AS id, count(i) AS deg')) {
    const id = String(r.id);
    if ((Number(r.deg) || 0) >= minImportDegree && (symCount.get(id) ?? 0) === 0) barrels.add(id);
  }
  return barrels;
}

export async function fileExists(db: CodeGraphDB, id: string): Promise<boolean> {
  const rows = await db.run('MATCH (f:File {id:$id}) RETURN f.id AS id', { id });
  return rows.length > 0;
}

export async function getMeta(db: CodeGraphDB, key: string): Promise<string | null> {
  const rows = await db.run('MATCH (m:Meta {key:$k}) RETURN m.val AS val', { k: key });
  return rows.length > 0 ? String(rows[0]!.val) : null;
}
