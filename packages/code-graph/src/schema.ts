import type { CodeGraphDB } from './db';

/**
 * Kùzu schema for a per-repo code graph (ADR-07). Edges are unioned by provenance
 * (ADR-06): `Imports` (structural), `Refs` (precise, alias-aware) and `CoChange`
 * (git history).
 *
 * `CoChangePending` is the incremental staging lane (ADR-26): sub-threshold co-change
 * pairs accumulate here ACROSS update windows and promote to a real `CoChange` edge once
 * their total `cnt` reaches `minPairCount`. Read queries must never traverse it.
 *
 * `File.id` is the repo-relative POSIX path (unique within a per-repo DB).
 * `Symbol.id` is `<file>#<name>#<startLine>`.
 */
export const DDL: string[] = [
  `CREATE NODE TABLE IF NOT EXISTS File(
     id STRING, path STRING, repo STRING, lang STRING,
     PRIMARY KEY(id))`,
  `CREATE NODE TABLE IF NOT EXISTS Symbol(
     id STRING, name STRING, kind STRING, file STRING,
     startLine INT64, endLine INT64, exported BOOLEAN,
     PRIMARY KEY(id))`,
  `CREATE NODE TABLE IF NOT EXISTS Meta(key STRING, val STRING, PRIMARY KEY(key))`,
  `CREATE REL TABLE IF NOT EXISTS Declares(FROM File TO Symbol)`,
  `CREATE REL TABLE IF NOT EXISTS Imports(FROM File TO File)`,
  `CREATE REL TABLE IF NOT EXISTS Refs(FROM File TO File)`,
  `CREATE REL TABLE IF NOT EXISTS CoChange(FROM File TO File, weight DOUBLE, cnt INT64)`,
  `CREATE REL TABLE IF NOT EXISTS CoChangePending(FROM File TO File, weight DOUBLE, cnt INT64, ts DOUBLE)`,
];

export async function initSchema(db: CodeGraphDB): Promise<void> {
  for (const stmt of DDL) {
    await db.run(stmt);
  }
  // Column migrations for graphs created before a column existed (swallow "already exists").
  try {
    await db.run('ALTER TABLE CoChangePending ADD ts DOUBLE');
  } catch {
    /* column exists */
  }
}
