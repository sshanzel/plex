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

/**
 * Co-change "degree" of each file in `ids` — the sum of its incident CoChange edge weights. Used
 * to normalize pair strength into an association-strength / Salton-cosine score (tuning.md §4), so a
 * file that co-changes with *everything* (a config, lockfile, or barrel) doesn't dominate the blast
 * radius. Read-only over the stored weights — no schema or incremental-merge change.
 */
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
 * Total coupling degree of each file — the count of incident File↔File edges (CoChange ∪ Imports ∪
 * Refs; the `b:File` end excludes File→Symbol Declares edges). A proxy for "how widely depended-on
 * this file is", used to enrich a finding's `blast` (how much could break if this code is wrong).
 */
export async function getCouplingDegrees(db: CodeGraphDB, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db.run(
    'MATCH (a:File)-[r]-(b:File) WHERE a.id IN $ids RETURN a.id AS id, count(r) AS deg',
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

export async function fileExists(db: CodeGraphDB, id: string): Promise<boolean> {
  const rows = await db.run('MATCH (f:File {id:$id}) RETURN f.id AS id', { id });
  return rows.length > 0;
}

export async function getMeta(db: CodeGraphDB, key: string): Promise<string | null> {
  const rows = await db.run('MATCH (m:Meta {key:$k}) RETURN m.val AS val', { k: key });
  return rows.length > 0 ? String(rows[0]!.val) : null;
}
