import { Database, Connection, type QueryResult } from 'kuzu';
import { RepoBusyError, isLockError } from '@plex/core';

type Row = Record<string, unknown>;
type Params = Record<string, unknown>;

/**
 * Thin wrapper over a Kùzu database + connection.
 *
 * Use `run(stmt, params)` with named `$params` for anything containing file paths or
 * user data — never string-concatenate (AGENTS.md). `insertMany` reuses a single
 * prepared statement for bulk DML.
 */
export class CodeGraphDB {
  private readonly db: Database;
  private readonly conn: Connection;

  constructor(public readonly dir: string, opts?: { readOnly?: boolean }) {
    try {
      // Kùzu's single-writer file lock can bite HERE or lazily at first query (`rethrow`
      // handles the lazy path) — either way a same-path concurrent open becomes a clear
      // RepoBusyError. readOnly=true lets multiple secondary worktrees share the base's
      // graph concurrently without conflicting on the write lock (ADR-32).
      this.db = opts?.readOnly ? new Database(dir, 0, true, true) : new Database(dir);
      this.conn = new Connection(this.db);
    } catch (e) {
      if (isLockError(e)) throw new RepoBusyError(dir);
      throw e;
    }
  }

  private static rows(res: QueryResult | QueryResult[]): Promise<Row[]> {
    const qr = Array.isArray(res) ? res[res.length - 1] : res;
    return qr ? (qr.getAll() as Promise<Row[]>) : Promise.resolve([]);
  }

  /** Translate Kùzu's lazy file-lock IOException (it locks at first query, not at open) into a
   *  clear RepoBusyError; pass every other error through untouched. */
  private rethrow(e: unknown): never {
    if (isLockError(e)) throw new RepoBusyError(this.dir);
    throw e;
  }

  async run(stmt: string, params?: Params): Promise<Row[]> {
    try {
      if (params) {
        const prepared = await this.conn.prepare(stmt);
        const res = await this.conn.execute(prepared, params as Record<string, never>);
        return CodeGraphDB.rows(res);
      }
      const res = await this.conn.query(stmt);
      return CodeGraphDB.rows(res);
    } catch (e) {
      this.rethrow(e);
    }
  }

  async insertMany(stmt: string, rows: Params[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      const prepared = await this.conn.prepare(stmt);
      // ONE transaction for the whole batch. Without it Kùzu auto-commits every statement (an fsync
      // per row), so a large first index was ~14k serial round-trips — most of a ~70s wait on a
      // ~1.3k-file repo. A single commit is a large speedup AND makes the batch atomic: a failure rolls
      // back instead of leaving a half-written graph (safe now that symbol ids are collision-proof, so
      // no mid-batch PK abort). The connection already holds the single writer, so there's no nesting.
      await this.conn.query('BEGIN TRANSACTION');
      try {
        for (const r of rows) await this.conn.execute(prepared, r as Record<string, never>);
        await this.conn.query('COMMIT');
      } catch (e) {
        await this.conn.query('ROLLBACK').catch(() => {}); // best-effort; surface the original error
        throw e;
      }
    } catch (e) {
      this.rethrow(e);
    }
  }

  async close(): Promise<void> {
    // Close the connection before the database — leaving the Connection's native
    // handle open leaks libuv resources and crashes worker teardown under vitest.
    await this.conn.close();
    await this.db.close();
  }
}
