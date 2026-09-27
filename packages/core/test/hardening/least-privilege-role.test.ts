// PH-T00: the app connects as `app_server` (migration 0017), never as the table-owning,
// RLS-bypassing role. Proves two things: the user path (SET LOCAL ROLE authenticated) stays fully
// tenant-isolated when reached through app_server's login, and app_server can still perform the
// trusted service-layer writes it needs, while lacking any privilege beyond that explicit list.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJob, inTenant, recordEvent, runAs, writeAudit, type Database } from "../../src";
import { count, inOrg, userActor } from "../helpers/db";
import { createWorld, type World } from "../helpers/fixtures";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

// `set local session authorization` (not `set role`) so that it changes session_user for the rest
// of this transaction only, exactly like a real TCP connection authenticated as app_server: `Tx`'s
// `asService` mode does `reset role`, which restores *session_user*, not whatever role was active
// before the last `set role`. Using plain `set role` here would make `reset role` fall back to
// this test runner's own superuser identity instead, silently defeating the point of these tests.
function asAppServer(db: Database): Database {
  return {
    transaction: (fn) =>
      db.transaction(async (exec) => {
        await exec.query("set local session authorization app_server");
        return fn(exec);
      }),
  };
}

async function rawAsAppServer<R = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: R[] }> {
  return w.pg.transaction(async (t) => {
    await t.query("set local session authorization app_server");
    const result = await t.query<R>(sql, params);
    return { rows: result.rows };
  });
}

async function rawAsAppServerThenUser<R = Record<string, unknown>>(
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: R[] }> {
  return w.pg.transaction(async (t) => {
    await t.query("set local session authorization app_server");
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    await t.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    await t.query("set local role authenticated");
    const result = await t.query<R>(sql, params);
    return { rows: result.rows };
  });
}

describe("app_server role attributes", () => {
  it("owns nothing and cannot elevate or create/drop objects", async () => {
    const { rows } = await w.pg.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolcanlogin: boolean;
    }>(
      `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
         from pg_roles where rolname = 'app_server'`,
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: true,
    });

    const owned = await count(
      w.pg,
      `select 1 from pg_tables where schemaname = 'public' and tableowner = 'app_server'`,
    );
    expect(owned).toBe(0);
  });

  it("cannot create tables, drop tables, or create roles", async () => {
    await expect(rawAsAppServer(`create table public.hack (id int)`)).rejects.toThrow();
    await expect(rawAsAppServer(`drop table public.customers`)).rejects.toThrow();
    await expect(rawAsAppServer(`create role sneaky login superuser`)).rejects.toThrow();
  });
});

describe("user paths stay RLS-isolated when reached through app_server", () => {
  it("org A user cannot read org B's customer, even by id", async () => {
    const { rows } = await rawAsAppServerThenUser(
      w.orgA.owner,
      `select * from public.customers where id = $1`,
      [w.orgB.customer.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("org A user cannot update org B's job", async () => {
    const { rows } = await rawAsAppServerThenUser(
      w.orgA.owner,
      `update public.jobs set name = 'hijacked' where id = $1 returning id`,
      [w.orgB.job.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("field employee cannot write a customer (staff-only policy still applies)", async () => {
    const { rows } = await rawAsAppServerThenUser(
      w.orgA.fieldEmployee,
      `update public.customers set notes = 'nope' where id = $1 returning id`,
      [w.orgA.customer.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("app_server can perform the trusted writes it needs", () => {
  it("real service code (job creation, audit, business events) succeeds over the app_server login", async () => {
    const appServerDb = asAppServer(w.db);
    const job = await inOrg(appServerDb, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      createJob(ctx, { name: "hardening job" }),
    );
    expect(job.id).toBeDefined();

    await runAs(appServerDb, { type: "system", name: "hardening-test" }, async (tx) => {
      const ctx = inTenant(tx, w.orgA.id);
      const { event } = await recordEvent(ctx, { type: "test.event" });
      expect(event.id).toBeDefined();
      const entry = await writeAudit(ctx, {
        action: "hardening.test",
        entityType: "business_event",
        entityId: event.id,
      });
      expect(entry.id).toBeDefined();
    });
  });

  it("directly, without switching role, app_server can insert an audit log entry", async () => {
    const { rows } = await rawAsAppServer<{ id: string }>(
      `insert into public.audit_log (organization_id, actor_type, action) values ($1, 'system', 'hardening.test') returning id`,
      [w.orgA.id],
    );
    expect(rows).toHaveLength(1);
  });
});
