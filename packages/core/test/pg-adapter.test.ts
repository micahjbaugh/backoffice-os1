// Runs the critical flows through the *production* node-postgres adapter over the Postgres wire
// protocol (PGlite served via pglite-socket), so driver-specific behavior is covered too:
// jsonb parameter encoding, int8 parsing, transaction-local role/claims, rollback hygiene.

import { randomUUID } from "node:crypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError, type Actor } from "@backoffice/domain";
import { createApproval, decideApproval, getCustomer, listCustomers, type Database } from "../src";
import { createPgDatabase, createPgPool } from "../src/db/pg";
import { count, inOrg, userActor } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
let server: PGLiteSocketServer;
let pool: pg.Pool;
let pgDb: Database;

beforeAll(async () => {
  w = await createWorld();
  const port = 55_000 + Math.floor(Math.random() * 5_000);
  server = new PGLiteSocketServer({ db: w.pg, port, host: "127.0.0.1" });
  await server.start();
  // PGlite is a single session, so the pool must not interleave transactions.
  pool = createPgPool(`postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`, 1);
  pgDb = createPgDatabase(pool);
});

afterAll(async () => {
  await pool?.end();
  await server?.stop();
  await w?.close();
});

const system: Actor = { type: "system", name: "pg-adapter-test" };

describe("node-postgres adapter", () => {
  it("enforces tenant isolation through RLS", async () => {
    const customers = await inOrg(pgDb, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      listCustomers(ctx),
    );
    expect(customers.length).toBeGreaterThan(0);
    expect(customers.every((c) => c.organizationId === w.orgA.id)).toBe(true);
    await expect(
      inOrg(pgDb, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        getCustomer(ctx, w.orgB.customer.id),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inOrg(pgDb, userActor(w.orgA.owner), w.orgB.id, (ctx) => listCustomers(ctx)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("decides an approval exactly once with event + audit, and types round-trip", async () => {
    const { approval } = await inOrg(pgDb, system, w.orgA.id, (ctx) =>
      createApproval(ctx, {
        type: "purchase",
        title: "Rock",
        amountCents: 45_000,
        idempotencyKey: `pg-${randomUUID()}`,
      }),
    );
    expect(approval.amountCents).toBe(45_000);

    const decide = () =>
      inOrg(pgDb, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        decideApproval(ctx, { approvalId: approval.id, decision: "approved" }),
      );
    const first = await decide();
    const second = await decide();
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(first.event.payload).toMatchObject({ decision: "approved", amount_cents: 45_000 });

    expect(
      await count(
        w.pg,
        `select 1 from public.business_events
          where type = 'approval.decided' and entity_id = $1 and jsonb_typeof(payload) = 'object'`,
        [approval.id],
      ),
    ).toBe(1);
    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log where action = 'approval.decided' and approval_id = $1`,
        [approval.id],
      ),
    ).toBe(1);
  });

  it("denies a field employee and audits the denial", async () => {
    const { approval } = await inOrg(pgDb, system, w.orgA.id, (ctx) =>
      createApproval(ctx, {
        type: "purchase",
        title: "Pipe",
        amountCents: 1_000,
        idempotencyKey: `pg-${randomUUID()}`,
      }),
    );
    await expect(
      inOrg(pgDb, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
        decideApproval(ctx, { approvalId: approval.id, decision: "approved" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log where action = 'authz.denied' and entity_id = $1`,
        [approval.id],
      ),
    ).toBe(1);
  });

  it("never leaks role or claims to the next user of a pooled connection", async () => {
    await inOrg(pgDb, userActor(w.orgA.owner), w.orgA.id, (ctx) => listCustomers(ctx));
    await expect(
      inOrg(pgDb, userActor(w.orgA.owner), w.orgB.id, (ctx) => listCustomers(ctx)),
    ).rejects.toThrow();

    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ who: string; sub: string | null }>(
        `select current_user as who, nullif(current_setting('request.jwt.claims', true), '') as sub`,
      );
      expect(rows[0]).toEqual({ who: "postgres", sub: null });
    } finally {
      client.release();
    }
  });
});
