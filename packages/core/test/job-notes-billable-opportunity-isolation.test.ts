// M3-T05: tenant isolation for job notes and billable opportunities (0009_job_notes_billable_opportunities.sql).
// Both tables are staff-only client-writable draft tables like time entries and equipment/material
// usage (0007/0008), so every check runs directly against the database as an authenticated user via
// `rawAsUser`, exactly like a PostgREST client would, proving RLS holds on its own.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { count, rawAsUser } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

interface Seed {
  jobNoteId: string;
  billableOpportunityId: string;
}

async function seedRows(w: World, orgId: string, jobId: string): Promise<Seed> {
  const { rows: n } = await w.pg.query<{ id: string }>(
    `insert into public.job_notes (organization_id, job_id, body) values ($1, $2, 'graded extra area') returning id`,
    [orgId, jobId],
  );
  const { rows: b } = await w.pg.query<{ id: string }>(
    `insert into public.billable_opportunities (organization_id, job_id, description, quantity, unit)
     values ($1, $2, 'grade another 200 ft', 200, 'ft') returning id`,
    [orgId, jobId],
  );
  return {
    jobNoteId: (n[0] as { id: string }).id,
    billableOpportunityId: (b[0] as { id: string }).id,
  };
}

let w: World;
let seedA: Seed;
let seedB: Seed;

beforeAll(async () => {
  w = await createWorld();
  seedA = await seedRows(w, w.orgA.id, w.orgA.job.id);
  seedB = await seedRows(w, w.orgB.id, w.orgB.job.id);
});
afterAll(async () => {
  await w.close();
});

interface TableCase {
  table: "job_notes" | "billable_opportunities";
  action: string;
  idOf: (s: Seed) => string;
  insertSql: string;
}

const cases: TableCase[] = [
  {
    table: "job_notes",
    action: "job_note",
    idOf: (s) => s.jobNoteId,
    insertSql: `insert into public.job_notes (organization_id, job_id, body) values ($1, $2, 'x')`,
  },
  {
    table: "billable_opportunities",
    action: "billable_opportunity",
    idOf: (s) => s.billableOpportunityId,
    insertSql: `insert into public.billable_opportunities (organization_id, job_id, description) values ($1, $2, 'x')`,
  },
];

describe.each(cases)("M3-T05: $table tenant isolation", (cfg) => {
  it.each(["owner", "officeAdmin", "manager"] as const)("%s sees no org B rows", async (role) => {
    const { rows } = await rawAsUser(
      w.pg,
      w.orgA[role],
      `select * from public.${cfg.table} where organization_id = $1`,
      [w.orgB.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("org A cannot fetch org B's row by id", async () => {
    const { rows } = await rawAsUser(
      w.pg,
      w.orgA.owner,
      `select * from public.${cfg.table} where id = $1`,
      [cfg.idOf(seedB)],
    );
    expect(rows).toHaveLength(0);
  });

  it("unfiltered queries only ever return the caller's own org", async () => {
    const { rows } = await rawAsUser<{ organization_id: string }>(
      w.pg,
      w.orgA.owner,
      `select organization_id from public.${cfg.table}`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organization_id === w.orgA.id)).toBe(true);
  });

  it("field employees, accountants, and outsiders cannot read rows", async () => {
    for (const user of [w.orgA.fieldEmployee, w.orgA.accountant, w.outsider]) {
      const { rows } = await rawAsUser(
        w.pg,
        user,
        `select * from public.${cfg.table} where id = $1`,
        [cfg.idOf(seedA)],
      );
      expect(rows).toHaveLength(0);
    }
  });

  it("anonymous callers are rejected outright", async () => {
    await expect(rawAsUser(w.pg, null, `select * from public.${cfg.table}`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it("RLS rejects inserting a row into org B", async () => {
    await expect(
      rawAsUser(w.pg, w.orgA.owner, cfg.insertSql, [w.orgB.id, w.orgB.job.id]),
    ).rejects.toThrow(/row-level security/);
  });

  it("field employees and accountants cannot mutate rows", async () => {
    for (const user of [w.orgA.fieldEmployee, w.orgA.accountant]) {
      await expect(
        rawAsUser(w.pg, user, cfg.insertSql, [w.orgA.id, w.orgA.job.id]),
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("org A cannot update or delete org B's row", async () => {
    const deleted = await rawAsUser(
      w.pg,
      w.orgA.owner,
      `delete from public.${cfg.table} where id = $1`,
      [cfg.idOf(seedB)],
    );
    expect(deleted.rowCount).toBe(0);

    const { rows } = await w.pg.query(`select id from public.${cfg.table} where id = $1`, [
      cfg.idOf(seedB),
    ]);
    expect(rows).toHaveLength(1);
  });

  it("RLS rejects moving a row into org B", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `update public.${cfg.table} set organization_id = $2 where id = $1`,
        [cfg.idOf(seedA), w.orgB.id],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("a manager can update a row in their own org, audited", async () => {
    const updateSql =
      cfg.table === "billable_opportunities"
        ? `update public.billable_opportunities set status = 'approved' where id = $1`
        : `update public.job_notes set body = 'updated note' where id = $1`;
    const updated = await rawAsUser(w.pg, w.orgA.manager, updateSql, [cfg.idOf(seedA)]);
    expect(updated.rowCount).toBe(1);

    expect(
      await count(w.pg, `select 1 from public.audit_log where entity_id = $1 and action = $2`, [
        cfg.idOf(seedA),
        `${cfg.action}.created`,
      ]),
    ).toBe(1);
    expect(
      await count(w.pg, `select 1 from public.audit_log where entity_id = $1 and action = $2`, [
        cfg.idOf(seedA),
        `${cfg.action}.updated`,
      ]),
    ).toBe(1);
  });
});

describe("M3-T05: cross-table FK isolation", () => {
  it("a same-org job reference from another org is rejected for job_notes", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.job_notes (organization_id, job_id, body) values ($1, $2, 'x')`,
        [w.orgA.id, w.orgB.job.id],
      ),
    ).rejects.toThrow();
  });

  it("a same-org job reference from another org is rejected for billable_opportunities", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.billable_opportunities (organization_id, job_id, description) values ($1, $2, 'x')`,
        [w.orgA.id, w.orgB.job.id],
      ),
    ).rejects.toThrow();
  });
});
