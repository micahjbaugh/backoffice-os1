// node-postgres adapter. Server-only: the connection string is a privileged secret.

import pg from "pg";
import type { Database, QueryResult, SqlExecutor } from "./types";

// Return int8/numeric as JS numbers (amounts are integer cents, well within 2^53).
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
// SQL DATE is a calendar date with no timezone. node-postgres would build a Date at *local*
// midnight, which shifts depending on the process timezone; keep the "YYYY-MM-DD" text instead
// (SqlExecutor contract, see ./types.ts).
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export function createPgDatabase(pool: pg.Pool): Database {
  return {
    async transaction<T>(fn: (exec: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const exec: SqlExecutor = {
        async query<R>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>> {
          const result = await client.query(sql, params as unknown[] | undefined);
          return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
        },
      };
      try {
        await client.query("begin");
        const value = await fn(exec);
        await client.query("commit");
        return value;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export function createPgPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}
