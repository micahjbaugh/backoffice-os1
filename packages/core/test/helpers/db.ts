import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { Actor, UUID } from "@backoffice/domain";
import {
  inTenant,
  runAs,
  type Database,
  type ServiceContext,
  type SqlExecutor,
  type Tx,
} from "../../src";
import { DATE_OID } from "../../src/db/types";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "../../../../supabase/migrations");

function adapt(t: Transaction | PGlite): SqlExecutor {
  return {
    async query<R>(sql: string, params?: readonly unknown[]) {
      const result = await t.query<R>(sql, params as unknown[] | undefined);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
}

export interface TestDatabase {
  pg: PGlite;
  db: Database;
  close(): Promise<void>;
}

/** Fresh in-process Postgres with the Supabase shim and every repository migration applied. */
export async function createTestDatabase(): Promise<TestDatabase> {
  // Same DATE contract as the node-postgres adapter: calendar dates stay "YYYY-MM-DD" text.
  const pg = await PGlite.create({
    extensions: { pgcrypto },
    parsers: { [DATE_OID]: (value: string) => value },
  });
  await pg.exec(readFileSync(join(here, "supabase-shim.sql"), "utf8"));
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of migrations) {
    await pg.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  const db: Database = {
    transaction: (fn) => pg.transaction((t) => fn(adapt(t))),
  };
  return { pg, db, close: () => pg.close() };
}

export async function createUser(pg: PGlite, email: string): Promise<UUID> {
  const { rows } = await pg.query<{ id: UUID }>(
    `insert into auth.users (email) values ($1) returning id`,
    [email],
  );
  return (rows[0] as { id: UUID }).id;
}

export const userActor = (userId: UUID): Actor => ({ type: "user", userId });
export const operatorActor = (userId: UUID): Actor => ({ type: "internal_operator", userId });

/** Run a service call as `actor` inside organization `orgId`. */
export function inOrg<T>(
  db: Database,
  actor: Actor,
  orgId: UUID,
  fn: (ctx: ServiceContext) => Promise<T>,
): Promise<T> {
  return runAs(db, actor, (tx) => fn(inTenant(tx, orgId)));
}

export function asTx<T>(db: Database, actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runAs(db, actor, fn);
}

/**
 * Execute raw SQL exactly as a Supabase client (PostgREST) would for this user: role
 * `authenticated` with the user's JWT claims. Bypasses all application code, so it tests RLS alone.
 */
export async function rawAsUser<R = Record<string, unknown>>(
  pg: PGlite,
  userId: UUID | null,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: R[]; rowCount: number }> {
  return pg.transaction(async (t) => {
    const claims = userId ? JSON.stringify({ sub: userId, role: "authenticated" }) : "";
    await t.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    await t.query(userId ? "set local role authenticated" : "set local role anon");
    const result = await t.query<R>(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  });
}

export async function count(pg: PGlite, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pg.query<{ n: number }>(
    `select count(*)::int as n from (${sql}) q`,
    params,
  );
  return (rows[0] as { n: number }).n;
}
