import { Database, Connection, type QueryResult } from 'kuzu';

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

  constructor(public readonly dir: string) {
    this.db = new Database(dir);
    this.conn = new Connection(this.db);
  }

  private static rows(res: QueryResult | QueryResult[]): Promise<Row[]> {
    const qr = Array.isArray(res) ? res[res.length - 1] : res;
    return qr ? (qr.getAll() as Promise<Row[]>) : Promise.resolve([]);
  }

  /** Run a single statement; with params it is prepared+executed, else queried directly. */
  async run(stmt: string, params?: Params): Promise<Row[]> {
    if (params) {
      const prepared = await this.conn.prepare(stmt);
      const res = await this.conn.execute(prepared, params as Record<string, never>);
      return CodeGraphDB.rows(res);
    }
    const res = await this.conn.query(stmt);
    return CodeGraphDB.rows(res);
  }

  /** Execute one prepared statement across many parameter rows (bulk insert). */
  async insertMany(stmt: string, rows: Params[]): Promise<void> {
    if (rows.length === 0) return;
    const prepared = await this.conn.prepare(stmt);
    for (const r of rows) {
      await this.conn.execute(prepared, r as Record<string, never>);
    }
  }

  async close(): Promise<void> {
    // Close the connection before the database — leaving the Connection's native
    // handle open leaks libuv resources and crashes worker teardown under vitest.
    await this.conn.close();
    await this.db.close();
  }
}
