// M3-T03: tenant isolation for time entries (0007_time_entries.sql).
// Time entries are a staff-only client-writable table like leads (0004_leads.sql), so every check
// runs directly against the database as an authenticated user via `rawAsUser`, exactly like a
// PostgREST client would, proving RLS holds on its own.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmployee } from "../src";
import { count, inOrg, rawAsUser } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

interface Seed {
  employeeId: string;
  jobId: string;
  timeEntryId: string;
}

let w: World;
let seedA: Seed;
let seedB: Seed;

async function seedTimeEntry(w: World, orgId: string, jobId: string): Promise<Seed> {
  const employee = await inOrg(w.db, { type: "user", userId: (orgId === w.orgA.id ? w.orgA.owner : w.orgB.owner) }, orgId, (ctx) =>
    createEmployee(ctx, { displayName: "Jake Tyler", phone: "415-555-0142" }),
  );
  const { rows } = await w.pg.query<{ id: string }>(
    `insert into public.time_entries (organization_id, employee_id, job_id, work_date, start_at, end_at, hours)
     values ($1, $2, $3, '2026-01-05', '2026-01-05T07:00:00Z', '2026-01-05T17:30:00Z', 10.5)
     returning id`,
    [orgId, employee.id, jobId],
  );
  return { employeeId: employee.id, jobId, timeEntryId: (rows[0] as { id: string }).id };
}

beforeAll(async () => {
  w = await createWorld();
  seedA = await seedTimeEntry(w, w.orgA.id, w.orgA.job.id);
  seedB = await seedTimeEntry(w, w.orgB.id, w.orgB.job.id);
});
afterAll(async () => {
  await w.close();
});

describe("M3-T03: org A cannot read org B's time entries", () => {
  it.each(["owner", "officeAdmin", "manager"] as const)(
    "%s sees no org B time entries",
    async (role) => {
      const { rows } = await rawAsUser(
        w.pg,
        w.orgA[role],
        `select * from public.time_entries where organization_id = $1`,
        [w.orgB.id],
      );
      expect(rows).toHaveLength(0);
    },
  );

  it("org A cannot fetch org B's time entry by id", async () => {
    const { rows } = await rawAsUser(w.pg, w.orgA.owner, `select * from public.time_entries where id = $1`, [
      seedB.timeEntryId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("unfiltered queries only ever return the caller's own org", async () => {
    const { rows } = await rawAsUser<{ organization_id: string }>(
      w.pg,
      w.orgA.owner,
      `select organization_id from public.time_entries`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organization_id === w.orgA.id)).toBe(true);
  });

  it("field employees and accountants cannot read time entries", async () => {
    for (const user of [w.orgA.fieldEmployee, w.orgA.accountant]) {
      const { rows } = await rawAsUser(w.pg, user, `select * from public.time_entries where id = $1`, [
        seedA.timeEntryId,
      ]);
      expect(rows).toHaveLength(0);
    }
  });
});

describe("M3-T03: org A cannot write org B's time entries", () => {
  it("RLS rejects inserting a time entry into org B", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.time_entries (organization_id, employee_id, job_id, work_date)
         values ($1, $2, $3, '2026-01-05')`,
        [w.orgB.id, seedB.employeeId, seedB.jobId],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("org A cannot update or delete org B's time entry", async () => {
    const updated = await rawAsUser(
      w.pg,
      w.orgA.owner,
      `update public.time_entries set status = 'approved' where id = $1`,
      [seedB.timeEntryId],
    );
    expect(updated.rowCount).toBe(0);
    const deleted = await rawAsUser(w.pg, w.orgA.owner, `delete from public.time_entries where id = $1`, [
      seedB.timeEntryId,
    ]);
    expect(deleted.rowCount).toBe(0);

    const { rows } = await w.pg.query<{ status: string }>(
      `select status from public.time_entries where id = $1`,
      [seedB.timeEntryId],
    );
    expect(rows[0]?.status).toBe("draft");
  });

  it("RLS rejects moving org A's time entry into org B", async () => {
    await expect(
      rawAsUser(w.pg, w.orgA.owner, `update public.time_entries set organization_id = $2 where id = $1`, [
        seedA.timeEntryId,
        w.orgB.id,
      ]),
    ).rejects.toThrow(/row-level security/);
  });

  it("a same-org employee reference from another org is rejected", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.time_entries (organization_id, employee_id, job_id, work_date)
         values ($1, $2, $3, '2026-01-05')`,
        [w.orgA.id, seedB.employeeId, w.orgA.job.id],
      ),
    ).rejects.toThrow();
  });

  it("field employees and accountants cannot mutate time entries", async () => {
    for (const user of [w.orgA.fieldEmployee, w.orgA.accountant]) {
      await expect(
        rawAsUser(
          w.pg,
          user,
          `insert into public.time_entries (organization_id, employee_id, job_id, work_date)
           values ($1, $2, $3, '2026-01-05')`,
          [w.orgA.id, seedA.employeeId, w.orgA.job.id],
        ),
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("a manager can approve a draft time entry in their own org, audited", async () => {
    const updated = await rawAsUser(
      w.pg,
      w.orgA.manager,
      `update public.time_entries set status = 'approved' where id = $1`,
      [seedA.timeEntryId],
    );
    expect(updated.rowCount).toBe(1);

    expect(
      await count(w.pg, `select 1 from public.audit_log where entity_id = $1 and action = $2`, [
        seedA.timeEntryId,
        "time_entry.created",
      ]),
    ).toBe(1);
    expect(
      await count(w.pg, `select 1 from public.audit_log where entity_id = $1 and action = $2`, [
        seedA.timeEntryId,
        "time_entry.updated",
      ]),
    ).toBe(1);
  });
});

describe("M3-T03: outsiders and anonymous callers see nothing", () => {
  it("an unaffiliated authenticated user reads no time entries", async () => {
    const { rows } = await rawAsUser(w.pg, w.outsider, `select * from public.time_entries`);
    expect(rows).toHaveLength(0);
  });

  it("anonymous callers are rejected outright", async () => {
    await expect(rawAsUser(w.pg, null, `select * from public.time_entries`)).rejects.toThrow(
      /permission denied/,
    );
  });
});
