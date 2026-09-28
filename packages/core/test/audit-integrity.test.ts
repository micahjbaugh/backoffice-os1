// Audit coverage, append-only guarantees, and client privilege boundaries.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, type Actor } from "@backoffice/domain";
import {
  createCustomer,
  createEmployee,
  createTask,
  createVendor,
  listAudit,
  registerDocument,
  updateTaskStatus,
} from "../src";
import { count, inOrg, rawAsUser, userActor } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

const auditsFor = (entityId: string, action: string) =>
  count(w.pg, `select 1 from public.audit_log where entity_id = $1 and action = $2`, [
    entityId,
    action,
  ]);

describe("every consequential mutation is audited", () => {
  it("record creation through services is audited with the acting user", async () => {
    const owner = userActor(w.orgA.owner);
    const customer = await inOrg(w.db, owner, w.orgA.id, (ctx) =>
      createCustomer(ctx, { displayName: "Wilson Farms" }),
    );
    const vendor = await inOrg(w.db, owner, w.orgA.id, (ctx) =>
      createVendor(ctx, { displayName: "Rock Supply Co" }),
    );
    const employee = await inOrg(w.db, owner, w.orgA.id, (ctx) =>
      createEmployee(ctx, { displayName: "Jake" }),
    );
    const task = await inOrg(w.db, owner, w.orgA.id, (ctx) =>
      createTask(ctx, { title: "Call Wilson back", priority: "high" }),
    );
    await inOrg(w.db, owner, w.orgA.id, (ctx) => updateTaskStatus(ctx, task.id, "done"));

    expect(await auditsFor(customer.id, "customer.created")).toBe(1);
    expect(await auditsFor(vendor.id, "vendor.created")).toBe(1);
    expect(await auditsFor(employee.id, "employee.created")).toBe(1);
    expect(await auditsFor(task.id, "task.created")).toBe(1);
    expect(await auditsFor(task.id, "task.updated")).toBe(1);

    const { rows } = await w.pg.query<{
      actor_type: string;
      actor_id: string;
      details: { changed_columns: string[] };
    }>(
      `select actor_type, actor_id, details from public.audit_log where entity_id = $1 and action = 'task.updated'`,
      [task.id],
    );
    expect(rows[0]).toMatchObject({ actor_type: "user", actor_id: w.orgA.owner });
    expect(rows[0]?.details.changed_columns).toEqual(["status"]);
  });

  it("direct client writes (bypassing the app) are still audited", async () => {
    const { rows } = await rawAsUser<{ id: string }>(
      w.pg,
      w.orgA.manager,
      `insert into public.customers (organization_id, display_name) values ($1, 'Direct Insert') returning id`,
      [w.orgA.id],
    );
    const id = (rows[0] as { id: string }).id;
    await rawAsUser(w.pg, w.orgA.manager, `delete from public.customers where id = $1`, [id]);
    expect(await auditsFor(id, "customer.created")).toBe(1);
    expect(await auditsFor(id, "customer.deleted")).toBe(1);
  });

  it("agent-created records are attributed to the agent", async () => {
    const agent: Actor = { type: "agent", name: "field_capture" };
    const task = await inOrg(w.db, agent, w.orgA.id, (ctx) =>
      createTask(ctx, { title: "Clarify hours for Jake" }),
    );
    const { rows } = await w.pg.query<{ actor_type: string; details: { actor_label: string } }>(
      `select actor_type, details from public.audit_log where entity_id = $1 and action = 'task.created'`,
      [task.id],
    );
    expect(rows[0]?.actor_type).toBe("agent");
    expect(rows[0]?.details.actor_label).toBe("agent:field_capture");
  });

  it("document metadata registration is audited and tenant-checked", async () => {
    const doc = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      registerDocument(ctx, {
        storagePath: `${w.orgA.id}/receipts/r1.pdf`,
        fileName: "r1.pdf",
        classification: "financial",
        entityType: "job",
        entityId: w.orgA.job.id,
      }),
    );
    expect(await auditsFor(doc.id, "document.created")).toBe(1);
    await expect(
      inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        registerDocument(ctx, {
          storagePath: "x",
          fileName: "x",
          entityType: "job",
          entityId: w.orgB.job.id,
        }),
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe("audit log and events are append-only", () => {
  it("rejects update and delete even from privileged code", async () => {
    await expect(w.pg.query(`update public.audit_log set action = 'tampered'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(w.pg.query(`delete from public.audit_log`)).rejects.toThrow(/append-only/);
    await expect(w.pg.query(`update public.business_events set type = 'tampered'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(w.pg.query(`delete from public.business_events`)).rejects.toThrow(/append-only/);
    await expect(w.pg.query(`truncate public.audit_log`)).rejects.toThrow(/append-only/);
  });

  it("clients cannot insert forged audit records or events", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.audit_log (organization_id, actor_type, action) values ($1, 'user', 'forged')`,
        [w.orgA.id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.business_events (organization_id, type, source, actor_type) values ($1, 'approval.decided', 'x', 'user')`,
        [w.orgA.id],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("client privilege boundaries", () => {
  it.each([
    ["organizations", `update public.organizations set name = 'x'`],
    ["memberships", `update public.memberships set role = 'owner'`],
    [
      "business_rules",
      `insert into public.business_rules (organization_id, action, definition) values ('00000000-0000-4000-8000-000000000000', 'approval.decide', '{}')`,
    ],
    ["ops_cases", `update public.ops_cases set status = 'closed'`],
    [
      "internal_staff",
      `insert into public.internal_staff (user_id, role) values (auth.uid(), 'platform_admin')`,
    ],
    ["webhook_receipts", `update public.webhook_receipts set status = 'processed'`],
  ])("authenticated clients cannot write %s directly", async (_table, sql) => {
    await expect(rawAsUser(w.pg, w.orgA.owner, sql)).rejects.toThrow(/permission denied/);
  });

  it("a field employee cannot escalate their own role", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.fieldEmployee,
        `update public.memberships set role = 'owner' where user_id = auth.uid()`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("field employees cannot write records", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
        createCustomer(ctx, { displayName: "x" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const { rowCount } = await rawAsUser(
      w.pg,
      w.orgA.fieldEmployee,
      `update public.customers set notes = 'x'`,
    );
    expect(rowCount).toBe(0);
  });

  it("audit log is readable by owner/admin/accountant, not manager or field employee", async () => {
    for (const user of [w.orgA.owner, w.orgA.officeAdmin, w.orgA.accountant]) {
      const entries = await inOrg(w.db, userActor(user), w.orgA.id, (ctx) => listAudit(ctx));
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.organizationId === w.orgA.id)).toBe(true);
    }
    for (const user of [w.orgA.manager, w.orgA.fieldEmployee]) {
      await expect(
        inOrg(w.db, userActor(user), w.orgA.id, (ctx) => listAudit(ctx)),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const { rows } = await rawAsUser(w.pg, user, `select * from public.audit_log`);
      expect(rows).toHaveLength(0);
    }
  });
});
