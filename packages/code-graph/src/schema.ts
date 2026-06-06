import type { CodeGraphDB } from './db';

/**
 * Kùzu schema for a per-repo code graph (ADR-07). Edges are unioned by provenance
 * (ADR-06): `Imports` (structural) and `CoChange` (git history). Precise call/ref
 * edges (M2) extend this with a `References` rel table.
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
];

export async function initSchema(db: CodeGraphDB): Promise<void> {
  for (const stmt of DDL) {
    await db.run(stmt);
  }
}
