// Minimal SQL surface the Business Brain needs. Driver-specific code (node-postgres in the app,
// PGlite in tests) implements this; services never import a driver.

export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

export interface SqlExecutor {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface Database {
  /** Run `fn` inside one database transaction on one connection; commit on success, roll back on throw. */
  transaction<T>(fn: (exec: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Postgres error code for a unique violation. */
export const PG_UNIQUE_VIOLATION = "23505";
/** Postgres error code for insufficient privilege (includes RLS WITH CHECK failures). */
export const PG_INSUFFICIENT_PRIVILEGE = "42501";

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
