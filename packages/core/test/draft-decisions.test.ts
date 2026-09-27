// Finding 7: decisions on draft records must go through authorized services. Direct client access
// (what a staff member could do with their own JWT through PostgREST) may create and edit drafts,
// but can never approve, reject, bill, or touch a decided record.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError, type Actor } from "@backoffice/domain";
import {
  createApprovalRuleVersion,
  decideBillableOpportunity,
  decideDraftRecord,
  retireRule,
} from "../src";
import { count, inOrg, rawAsUser, userActor } from "./helpers/db";
import { seedEmployee, seedEquipment } from "./helpers/draft-facts";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
let employeeId: string;
let equipmentId: string;

beforeAll(async () => {
  w = await createWorld();
  employeeId = await seedEmployee(w, w.orgA.id);
  equipmentId = await seedEquipment(w, w.orgA.id);
});
afterAll(async () => {
  await w.close();
});

type Table = "time_entries" | "equipment_usages" | "material_usages" | "billable_opportunities";

async function seed(table: Table, orgId = w.orgA.id, jobId = w.orgA.job.id): Promise<string> {
  const sql: Record<Table, [string, unknown[]]> = {
    time_entries: [
      `insert into public.time_entries (organization_id, employee_id, job_id, work_date, hours) values ($1, $2, $3, '2026-01-05', 8) returning id`,
      [orgId, employeeId, jobId],
    ],
    equipment_usages: [
      `insert into public.equipment_usages (organization_id, equipment_id, job_id, hours) values ($1, $2, $3, 6.5) returning id`,
      [orgId, equipmentId, jobId],
    ],
    material_usages: [
      `insert into public.material_usages (organization_id, job_id, description, quantity, unit) values ($1, $2, 'crushed rock', 21, 'ton') returning id`,
      [orgId, jobId],
    ],
    billable_opportunities: [
      `insert into public.billable_opportunities (organization_id, job_id, description, quantity, unit) values ($1, $2, 'grade another 200 ft', 200, 'ft') returning id`,
      [orgId, jobId],
    ],
  };
  const [q, params] = sql[table];
  const { rows } = await w.pg.query<{ id: string }>(q, params);
  return (rows[0] as { id: string }).id;
}

const statusOf = async (table: Table, id: string) =>
  (await w.pg.query<{ status: string }>(`select status from public.${table} where id = $1`, [id]))
    .rows[0]?.status;

const editable: Record<Table, string> = {
  time_entries: "hours = 9",
  equipment_usages: "hours = 7",
  material_usages: "quantity = 22",
  billable_opportunities: "quantity = 250",
};
const approvedValue: Record<Table, string> = {
  time_entries: "approved",
  equipment_usages: "approved",
  material_usages: "approved",
  billable_opportunities: "approved",
};
const TABLES: Table[] = [
  "time_entries",
  "equipment_usages",
  "material_usages",
  "billable_opportunities",
];

describe("direct client access (PostgREST-equivalent)", () => {
  it.each(TABLES)("%s: owner/admin/manager cannot set status on a draft", async (table) => {
    const id = await seed(table);
    for (const user of [w.orgA.owner, w.orgA.officeAdmin, w.orgA.manager]) {
      await expect(
        rawAsUser(
          w.pg,
          user,
          `update public.${table} set status = '${approvedValue[table]}' where id = $1`,
          [id],
        ),
      ).rejects.toThrow(/permission denied/);
    }
    expect(["draft", "open"]).toContain(await statusOf(table, id));
  });

  it.each(TABLES)("%s: cannot insert an already-decided row or forge a decider", async (table) => {
    const cols =
      table === "time_entries"
        ? "employee_id, job_id, work_date"
        : table === "equipment_usages"
          ? "equipment_id, job_id"
          : "job_id, description";
    const vals =
      table === "time_entries"
        ? `'${employeeId}', $2, '2026-01-06'`
        : table === "equipment_usages"
          ? `'${equipmentId}', $2`
          : `$2, 'x'`;
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.manager,
        `insert into public.${table} (organization_id, ${cols}, status) values ($1, ${vals}, '${approvedValue[table]}')`,
        [w.orgA.id, w.orgA.job.id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.manager,
        `insert into public.${table} (organization_id, ${cols}, decided_by_user_id) values ($1, ${vals}, $3)`,
        [w.orgA.id, w.orgA.job.id, w.orgA.owner],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it.each(TABLES)("%s: staff can still edit and delete drafts", async (table) => {
    const id = await seed(table);
    const edit = await rawAsUser(
      w.pg,
      w.orgA.manager,
      `update public.${table} set ${editable[table]} where id = $1`,
      [id],
    );
    expect(edit.rowCount).toBe(1);
    const del = await rawAsUser(w.pg, w.orgA.manager, `delete from public.${table} where id = $1`, [
      id,
    ]);
    expect(del.rowCount).toBe(1);
  });

  it.each(TABLES)("%s: decided rows cannot be edited or deleted by clients", async (table) => {
    const id = await seed(table);
    if (table === "billable_opportunities") {
      await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
        decideBillableOpportunity(ctx, { id, decision: "approved" }),
      );
    } else {
      const kind = (
        {
          time_entries: "time_entry",
          equipment_usages: "equipment_usage",
          material_usages: "material_usage",
        } as const
      )[table];
      await inOrg(w.db, userActor(w.orgA.manager), w.orgA.id, (ctx) =>
        decideDraftRecord(ctx, { kind, id, decision: "approved" }),
      );
    }
    const edit = await rawAsUser(
      w.pg,
      w.orgA.owner,
      `update public.${table} set ${editable[table]} where id = $1`,
      [id],
    );
    expect(edit.rowCount).toBe(0);
    const del = await rawAsUser(w.pg, w.orgA.owner, `delete from public.${table} where id = $1`, [
      id,
    ]);
    expect(del.rowCount).toBe(0);
    expect(await statusOf(table, id)).toBe("approved");
  });

  it.each(TABLES)("%s: field employees and accountants have no access", async (table) => {
    const id = await seed(table);
    for (const user of [w.orgA.fieldEmployee, w.orgA.accountant]) {
      const { rows } = await rawAsUser(w.pg, user, `select * from public.${table} where id = $1`, [
        id,
      ]);
      expect(rows).toHaveLength(0);
    }
  });
});

describe("database guard (even privileged code)", () => {
  it("a decided row is immutable", async () => {
    const id = await seed("time_entries");
    await inOrg(w.db, userActor(w.orgA.manager), w.orgA.id, (ctx) =>
      decideDraftRecord(ctx, { kind: "time_entry", id, decision: "rejected" }),
    );
    await expect(
      w.pg.query(`update public.time_entries set hours = 1 where id = $1`, [id]),
    ).rejects.toThrow(/already rejected/);
    await expect(
      w.pg.query(`update public.time_entries set status = 'approved' where id = $1`, [id]),
    ).rejects.toThrow(/already rejected/);
    await expect(w.pg.query(`delete from public.time_entries where id = $1`, [id])).rejects.toThrow(
      /cannot be deleted/,
    );
  });

  it("a decision must name the decider", async () => {
    const id = await seed("billable_opportunities");
    await expect(
      w.pg.query(`update public.billable_opportunities set status = 'approved' where id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/must record decided_by_user_id/);
  });
});

describe("decideDraftRecord (time, equipment, material)", () => {
  it("owner, office admin and manager can decide, with event + audit", async () => {
    for (const [user, decision] of [
      [w.orgA.owner, "approved"],
      [w.orgA.officeAdmin, "rejected"],
      [w.orgA.manager, "approved"],
    ] as const) {
      const id = await seed("time_entries");
      const { record, replayed } = await inOrg(w.db, userActor(user), w.orgA.id, (ctx) =>
        decideDraftRecord(ctx, { kind: "time_entry", id, decision, note: "checked" }),
      );
      expect(replayed).toBe(false);
      expect(record).toMatchObject({
        status: decision,
        decidedByUserId: user,
        decisionNote: "checked",
      });
      expect(record.decidedAt).not.toBeNull();
      expect(
        await count(
          w.pg,
          `select 1 from public.business_events where type = 'draft_record.decided' and entity_id = $1`,
          [id],
        ),
      ).toBe(1);
      expect(
        await count(w.pg, `select 1 from public.audit_log where action = $1 and entity_id = $2`, [
          `time_entry.${decision}`,
          id,
        ]),
      ).toBe(1);
    }
  });

  it("replays are no-ops and conflicting decisions are rejected", async () => {
    const id = await seed("material_usages");
    const decide = (decision: "approved" | "rejected") =>
      inOrg(w.db, userActor(w.orgA.manager), w.orgA.id, (ctx) =>
        decideDraftRecord(ctx, { kind: "material_usage", id, decision }),
      );
    expect((await decide("approved")).replayed).toBe(false);
    expect((await decide("approved")).replayed).toBe(true);
    await expect(decide("rejected")).rejects.toBeInstanceOf(ConflictError);
    expect(
      await count(
        w.pg,
        `select 1 from public.business_events where type = 'draft_record.decided' and entity_id = $1`,
        [id],
      ),
    ).toBe(1);
  });

  it("field employees, accountants and agents cannot decide", async () => {
    const id = await seed("equipment_usages");
    const agent: Actor = { type: "agent", name: "field-capture" };
    for (const actor of [userActor(w.orgA.fieldEmployee), userActor(w.orgA.accountant), agent]) {
      await expect(
        inOrg(w.db, actor, w.orgA.id, (ctx) =>
          decideDraftRecord(ctx, { kind: "equipment_usage", id, decision: "approved" }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await statusOf("equipment_usages", id)).toBe("draft");
  });

  it("is tenant-scoped", async () => {
    const id = await seed("time_entries");
    await expect(
      inOrg(w.db, userActor(w.orgB.owner), w.orgA.id, (ctx) =>
        decideDraftRecord(ctx, { kind: "time_entry", id, decision: "approved" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inOrg(w.db, userActor(w.orgB.owner), w.orgB.id, (ctx) =>
        decideDraftRecord(ctx, { kind: "time_entry", id, decision: "approved" }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await statusOf("time_entries", id)).toBe("draft");
  });
});

describe("decideBillableOpportunity (financial decision)", () => {
  const decide = (user: string, id: string, decision: "approved" | "dismissed" = "approved") =>
    inOrg(w.db, userActor(user), w.orgA.id, (ctx) =>
      decideBillableOpportunity(ctx, { id, decision }),
    );

  it("managers never decide; office admins need a delegation rule; owners decide", async () => {
    const id = await seed("billable_opportunities");
    await expect(decide(w.orgA.manager, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decide(w.orgA.officeAdmin, id)).rejects.toBeInstanceOf(ForbiddenError);
    const { record } = await decide(w.orgA.owner, id);
    expect(record).toMatchObject({
      status: "approved",
      decisionPolicySource: "default:owner",
      decidedByUserId: w.orgA.owner,
    });
    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log where action = 'billable_opportunity.approved' and entity_id = $1`,
        [id],
      ),
    ).toBe(1);
  });

  it("an owner rule can delegate billable decisions to office admins", async () => {
    const rule = await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) =>
      createApprovalRuleVersion(ctx, {
        ruleKey: "admin-change-orders",
        approvalTypes: ["change_order"],
        roles: ["office_admin"],
      }),
    );
    const id = await seed("billable_opportunities");
    const { record } = await decide(w.orgA.officeAdmin, id, "dismissed");
    expect(record.decisionPolicySource).toBe(`business_rule:${rule.id}@v1`);
    await inOrg(w.db, userActor(w.orgA.owner), w.orgA.id, (ctx) => retireRule(ctx, rule.id));
  });

  it("the denied attempt is audited", async () => {
    const id = await seed("billable_opportunities");
    await expect(decide(w.orgA.manager, id)).rejects.toThrow();
    expect(
      await count(
        w.pg,
        `select 1 from public.audit_log where action = 'authz.denied' and entity_id = $1`,
        [id],
      ),
    ).toBe(1);
  });
});
