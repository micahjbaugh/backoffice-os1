import "server-only";

import type { Database } from "@backoffice/core";
import { createPgDatabase, createPgPool } from "@backoffice/core/pg";
import { databaseUrl } from "./env";

// One pool per server process (survives dev hot reloads via globalThis).
const globalForDb = globalThis as unknown as { backofficeDb?: Database };

export function db(): Database {
  globalForDb.backofficeDb ??= createPgDatabase(createPgPool(databaseUrl()));
  return globalForDb.backofficeDb;
}
