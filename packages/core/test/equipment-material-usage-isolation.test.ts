// M3-T04: tenant isolation for equipment and material usage (0008_equipment_material_usage.sql).
// Both tables are staff-only client-writable draft tables like time entries (0007_time_entries.sql),
// so every check runs directly against the database as an authenticated user via `rawAsUser`,
// exactly like a PostgREST client would, proving RLS holds on its own. The two tables share the
// same shape (draft usage row, staff-only RLS, audit trigger), so their checks run table-driven.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { count, rawAsUser } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

interface Seed {
  equipmentId: string;
  equipmentUsageId: string;
  materialUsageId: string;
}

async function seedUsage(w: World, orgId: string, jobId: string): Promise<Seed> {
  const { rows: eq } = await w.pg.query<{ id: string }>(
    `insert into public.equipment (organization_id, name, type) values ($1, 'D6 Dozer', 'dozer') returning id`,
    [orgId],
  );
  const equipmentId = (eq[0] as { id: string }).id;
  const { rows: eu } = await w.pg.query<{ id: string }>(
    `insert into public.equipment_usages (organization_id, equipment_id, job_id, hours) values ($1, $2, $3, 6.5) returning id`,
    [orgId, equipmentId, jobId],
  );
  const { rows: mu } = await w.pg.query<{ id: string }>(
    `insert into public.material_usages (organization_id, job_id, description, quantity, unit) values ($1, $2, 'rock', 21, 'ton') returning id`,
    [orgId, jobId],
  );
  return {
    equipmentId,
    equipmentUsageId: (eu[0] as { id: string }).id,
    materialUsageId: (mu[0] as { id: string }).id,
  };
}

let w: World;
let seedA: Seed;
let seedB: Seed;

beforeAll(async () => {
  w = await createWorld();
  seedA = await seedUsage(w, w.orgA.id, w.orgA.job.id);
  seedB = await seedUsage(w, w.orgB.id, w.orgB.job.id);
});
afterAll(async () => {
  await w.close();
});

interface TableCase {
  table: "equipment_usages" | "material_usages";
  action: string;
  idOf: (s: Seed) => string;
  insertSql: string;
  insertParams: (orgId: string, jobId: string, s: Seed) => unknown[];
}

const cases: TableCase[] = [
  {
    table: "equipment_usages",
    action: "equipment_usage",
    idOf: (s) => s.equipmentUsageId,
    insertSql: `insert into public.equipment_usages (organization_id, equipment_id, job_id) values ($1, $2, $3)`,
    insertParams: (orgId, jobId, s) => [orgId, s.equipmentId, jobId],
  },
  {
    table: "material_usages",
    action: "material_usage",
    idOf: (s) => s.materialUsageId,
    insertSql: `insert into public.material_usages (organization_id, job_id, description) values ($1, $2, 'x')`,
    insertParams: (orgId, jobId) => [orgId, jobId],
  },
];

describe.each(cases)("M3-T04: $table tenant isolation", (cfg) => {
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
      rawAsUser(
        w.pg,
        w.orgA.owner,
        cfg.insertSql,
        cfg.insertParams(w.orgB.id, w.orgB.job.id, seedB),
      ),
    ).rejects.toThrow(/row-level security|permission denied/); // org is not client-updatable (0011)
  });

  it("field employees and accountants cannot mutate rows", async () => {
    for (const user of [w.orgA.fieldEmployee, w.orgA.accountant]) {
      await expect(
        rawAsUser(w.pg, user, cfg.insertSql, cfg.insertParams(w.orgA.id, w.orgA.job.id, seedA)),
      ).rejects.toThrow(/row-level security|permission denied/); // org is not client-updatable (0011)
    }
  });

  it("org A cannot update or delete org B's row", async () => {
    const updated = await rawAsUser(
      w.pg,
      w.orgA.owner,
      // Status is not client-writable at all (0011); an editable column exercises RLS isolation.
      `update public.${cfg.table} set confidence = '{"reviewed": true}'::jsonb where id = $1`,
      [cfg.idOf(seedB)],
    );
    expect(updated.rowCount).toBe(0);
    const deleted = await rawAsUser(
      w.pg,
      w.orgA.owner,
      `delete from public.${cfg.table} where id = $1`,
      [cfg.idOf(seedB)],
    );
    expect(deleted.rowCount).toBe(0);

    const { rows } = await w.pg.query<{ status: string }>(
      `select status from public.${cfg.table} where id = $1`,
      [cfg.idOf(seedB)],
    );
    expect(rows[0]?.status).toBe("draft");
  });

  it("RLS rejects moving a row into org B", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `update public.${cfg.table} set organization_id = $2 where id = $1`,
        [cfg.idOf(seedA), w.orgB.id],
      ),
    ).rejects.toThrow(/row-level security|permission denied/); // org is not client-updatable (0011)
  });

  it("a manager can edit a draft row in their own org, audited (decisions go through decideDraftRecord)", async () => {
    const updated = await rawAsUser(
      w.pg,
      w.orgA.manager,
      `update public.${cfg.table} set confidence = '{"reviewed": true}'::jsonb where id = $1`,
      [cfg.idOf(seedA)],
    );
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

describe("M3-T04: cross-table FK isolation", () => {
  it("a same-org equipment reference from another org is rejected", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.equipment_usages (organization_id, equipment_id, job_id) values ($1, $2, $3)`,
        [w.orgA.id, seedB.equipmentId, w.orgA.job.id],
      ),
    ).rejects.toThrow();
  });
});
