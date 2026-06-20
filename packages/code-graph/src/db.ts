import { Database, Connection, type QueryResult } from 'kuzu';
import { RepoBusyError, isLockError } from '@plex/core';

type Row = Record<string, unknown>;
type Params = Record<string, unknown>;

/**
 * Thin wrapper over a Kùzu database + connection. Use `run(stmt, params)` with named `$params` for
 * anything containing file paths or user data — never string-concatenate Cypher (AGENTS.md).
 */
export class CodeGraphDB {
  private readonly db: Database;
  private readonly conn: Connection;

  constructor(public readonly dir: string, opts?: { readOnly?: boolean }) {
    try {
      // Kùzu's single-writer file lock can bite HERE or lazily at first query (`rethrow` handles the
      // lazy path) → RepoBusyError. readOnly=true lets worktrees share the base's graph (ADR-32).
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

  /** Translate Kùzu's lazy file-lock IOException (locks at first query, not at open) into RepoBusyError; pass others through. */
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

  /**
   * Bulk insert under explicit per-CHUNK transactions — batching avoids Kùzu auto-committing (fsync)
   * every row (a large first index was ~14k serial commits); chunking bounds the WAL/undo buffer so a
   * huge monorepo can't balloon memory. NOT atomic: a chunk commits as it fills and callers issue
   * several `insertMany`s — a mid-build failure leaves a partial graph, recovered by the next full rebuild.
   * ROLLBACK on error closes the txn so the REUSED long-lived connection isn't left mid-transaction
   * (the next BEGIN would fail); the ORIGINAL error is surfaced.
   */
  async insertMany(stmt: string, rows: Params[]): Promise<void> {
    if (rows.length === 0) return;
    const CHUNK = 10_000;
    try {
      const prepared = await this.conn.prepare(stmt);
      let inTxn = false;
      try {
        for (let i = 0; i < rows.length; i++) {
          if (i % CHUNK === 0) {
            await this.conn.query('BEGIN TRANSACTION');
            inTxn = true;
          }
          await this.conn.execute(prepared, rows[i] as Record<string, never>);
          if (i % CHUNK === CHUNK - 1) {
            await this.conn.query('COMMIT');
            inTxn = false;
          }
        }
        if (inTxn) await this.conn.query('COMMIT');
      } catch (e) {
        if (inTxn) await this.conn.query('ROLLBACK').catch(() => {});
        throw e;
      }
    } catch (e) {
      this.rethrow(e);
    }
  }

  async close(): Promise<void> {
    // Close the Connection before the Database — the reverse leaks the native handle and crashes vitest teardown.
    await this.conn.close();
    await this.db.close();
  }
}
