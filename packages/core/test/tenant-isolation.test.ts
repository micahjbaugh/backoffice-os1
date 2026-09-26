// Required M1 tests 1 and 2, plus supporting tenant-isolation checks.
// Each property is checked twice: through the service layer, and directly against the database as
// the user (bypassing all app code) to prove RLS holds on its own.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "@backoffice/domain";
import {
  createApproval,
  createJob,
  createTask,
  getCustomer,
  listCustomers,
  listEvents,
  listMyOrganizations,
  updateJob,
} from "../src";
import { asTx, count, inOrg, rawAsUser, userActor } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

describe("1. org A user cannot read org B customer", () => {
  it("RLS returns no rows for org B's customer, even when queried by id", async () => {
    const { rows } = await rawAsUser(
      w.pg,
      w.orgA.owner,
      `select * from public.customers where id = $1`,
      [w.orgB.customer.id],
    );
    expect(rows).toHaveLength(0);

    const all = await rawAsUser<{ organization_id: string }>(
      w.pg,
      w.orgA.owner,
      `select * from public.customers`,
    );
    expect(all.rows.length).toBeGreaterThan(0);
    expect(all.rows.every((r) => r.organization_id === w.orgA.id)).toBe(true);
  });

  it("service rejects org A user acting in org B (and audits the attempt)", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.owner), w.orgB.id, (ctx) =>
        getCustomer(ctx, w.orgB.customer.id),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inOrg(w.db, userActor(w.orgA.owner), w.orgB.id, (ctx) => listCustomers(ctx)),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const denials = await count(
      w.pg,
      `select 1 from public.audit_log where action = 'authz.denied' and actor_id = $1 and organization_id = $2`,
      [w.orgA.owner, w.orgB.id],
    );
    expect(denials).toBeGreaterThanOrEqual(2);
  });

  it("service in org A cannot fetch org B's customer by id", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        getCustomer(ctx, w.orgB.customer.id),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("every role in org A is blind to org B customers", async () => {
    for (const user of [
      w.orgA.officeAdmin,
      w.orgA.manager,
      w.orgA.fieldEmployee,
      w.orgA.accountant,
    ]) {
      const { rows } = await rawAsUser(
        w.pg,
        user,
        `select * from public.customers where organization_id = $1`,
        [w.orgB.id],
      );
      expect(rows).toHaveLength(0);
    }
  });

  it("anonymous callers read nothing", async () => {
    await expect(rawAsUser(w.pg, null, `select * from public.customers`)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("2. org A user cannot update org B job", () => {
  it("RLS update of org B's job affects 0 rows and leaves it unchanged", async () => {
    const result = await rawAsUser(
      w.pg,
      w.orgA.owner,
      `update public.jobs set name = 'hijacked' where id = $1`,
      [w.orgB.job.id],
    );
    expect(result.rowCount).toBe(0);
    const { rows } = await w.pg.query<{ name: string }>(
      `select name from public.jobs where id = $1`,
      [w.orgB.job.id],
    );
    expect(rows[0]?.name).toBe(w.orgB.job.name);
  });

  it("RLS rejects moving an org A job into org B", async () => {
    await expect(
      rawAsUser(w.pg, w.orgA.owner, `update public.jobs set organization_id = $2 where id = $1`, [
        w.orgA.job.id,
        w.orgB.id,
      ]),
    ).rejects.toThrow(/row-level security/);
  });

  it("RLS rejects inserting a job into org B", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.jobs (organization_id, name) values ($1, 'x')`,
        [w.orgB.id],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("service rejects the update in org B context and cannot reach it from org A context", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.owner), w.orgB.id, (ctx) =>
        updateJob(ctx, w.orgB.job.id, { name: "hijacked" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        updateJob(ctx, w.orgB.job.id, { name: "hijacked" }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const { rows } = await w.pg.query<{ name: string }>(
      `select name from public.jobs where id = $1`,
      [w.orgB.job.id],
    );
    expect(rows[0]?.name).toBe(w.orgB.job.name);
  });

  it("owner can update their own org's job", async () => {
    const job = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      updateJob(ctx, w.orgA.job.id, { status: "scheduled" }),
    );
    expect(job.status).toBe("scheduled");
  });
});

describe("cross-tenant references", () => {
  it("cannot create a job pointing at another org's customer (service and DB)", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        createJob(ctx, { name: "sneaky", customerId: w.orgB.customer.id }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.jobs (organization_id, customer_id, name) values ($1, $2, 'x')`,
        [w.orgA.id, w.orgB.customer.id],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("cannot attach tasks or approvals to another org's entities", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        createTask(ctx, { title: "t", entityType: "job", entityId: w.orgB.job.id }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        createApproval(ctx, {
          type: "schedule.change",
          title: "x",
          idempotencyKey: "cross-tenant-1",
          entityType: "job",
          entityId: w.orgB.job.id,
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cannot assign a task to a user outside the org", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        createTask(ctx, { title: "t", assignedUserId: w.orgB.owner }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("other tenant tables", () => {
  it.each([
    "organizations",
    "memberships",
    "employees",
    "vendors",
    "tasks",
    "approvals",
    "business_rules",
    "business_events",
    "audit_log",
    "ops_cases",
    "notes",
    "documents",
    "internal_operator_grants",
  ])("org A owner sees no org B rows in %s", async (table) => {
    const orgColumn = table === "organizations" ? "id" : "organization_id";
    const { rows } = await rawAsUser(
      w.pg,
      w.orgA.owner,
      `select * from public.${table} where ${orgColumn} = $1`,
      [w.orgB.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("membership listing works (0001's recursive policy is fixed) and is org-scoped", async () => {
    const orgs = await asTx(w.db, userActor(w.orgA.fieldEmployee), (tx) => listMyOrganizations(tx));
    expect(orgs.map((o) => o.organization.id)).toEqual([w.orgA.id]);
    expect(orgs[0]?.role).toBe("field_employee");

    const { rows } = await rawAsUser<{ organization_id: string }>(
      w.pg,
      w.orgA.owner,
      `select * from public.memberships`,
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.organization_id === w.orgA.id)).toBe(true);
  });

  it("a user with no memberships sees nothing", async () => {
    for (const table of ["organizations", "customers", "jobs", "approvals"]) {
      const { rows } = await rawAsUser(w.pg, w.outsider, `select * from public.${table}`);
      expect(rows).toHaveLength(0);
    }
  });

  it("events are only listed for the actor's own org", async () => {
    const events = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) => listEvents(ctx));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.organizationId === w.orgA.id)).toBe(true);
  });
});
