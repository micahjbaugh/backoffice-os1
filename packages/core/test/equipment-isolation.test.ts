// M3-T02: tenant isolation for the equipment registry (0006_equipment.sql).
// Equipment is a client-writable record table like customers/employees/vendors (0001/0002 §5-6),
// so every check runs directly against the database as an authenticated user via `rawAsUser`,
// exactly like a PostgREST client would, proving RLS holds on its own.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { count, rawAsUser } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

interface Seed {
  equipmentId: string;
}

let w: World;
let seedA: Seed;
let seedB: Seed;

async function seedEquipment(w: World, orgId: string): Promise<Seed> {
  const { rows } = await w.pg.query<{ id: string }>(
    `insert into public.equipment (organization_id, name, type, aliases, internal_cost_rate_cents, billable_rate_cents)
     values ($1, 'John Deere 350G', 'excavator', array['Hoe','excavator'], 4500, 9500)
     returning id`,
    [orgId],
  );
  return { equipmentId: (rows[0] as { id: string }).id };
}

beforeAll(async () => {
  w = await createWorld();
  seedA = await seedEquipment(w, w.orgA.id);
  seedB = await seedEquipment(w, w.orgB.id);
});
afterAll(async () => {
  await w.close();
});

describe("M3-T02: org A cannot read org B's equipment", () => {
  it.each(["owner", "officeAdmin", "manager", "fieldEmployee", "accountant"] as const)(
    "%s sees no org B equipment rows",
    async (role) => {
      const { rows } = await rawAsUser(
        w.pg,
        w.orgA[role],
        `select * from public.equipment where organization_id = $1`,
        [w.orgB.id],
      );
      expect(rows).toHaveLength(0);
    },
  );

  it("org A cannot fetch org B's equipment by id", async () => {
    const { rows } = await rawAsUser(w.pg, w.orgA.owner, `select * from public.equipment where id = $1`, [
      seedB.equipmentId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("unfiltered queries only ever return the caller's own org", async () => {
    const { rows } = await rawAsUser<{ organization_id: string }>(
      w.pg,
      w.orgA.owner,
      `select organization_id from public.equipment`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organization_id === w.orgA.id)).toBe(true);
  });

  it("any org member can read their own org's equipment", async () => {
    const { rows } = await rawAsUser(
      w.pg,
      w.orgA.fieldEmployee,
      `select * from public.equipment where id = $1`,
      [seedA.equipmentId],
    );
    expect(rows).toHaveLength(1);
  });
});

describe("M3-T02: org A cannot write org B's equipment", () => {
  it("RLS rejects inserting equipment into org B", async () => {
    await expect(
      rawAsUser(
        w.pg,
        w.orgA.owner,
        `insert into public.equipment (organization_id, name, type) values ($1, 'x', 'y')`,
        [w.orgB.id],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("org A cannot update or delete org B's equipment", async () => {
    const updated = await rawAsUser(
      w.pg,
      w.orgA.owner,
      `update public.equipment set name = 'hijacked' where id = $1`,
      [seedB.equipmentId],
    );
    expect(updated.rowCount).toBe(0);
    const deleted = await rawAsUser(w.pg, w.orgA.owner, `delete from public.equipment where id = $1`, [
      seedB.equipmentId,
    ]);
    expect(deleted.rowCount).toBe(0);

    const { rows } = await w.pg.query<{ name: string }>(
      `select name from public.equipment where id = $1`,
      [seedB.equipmentId],
    );
    expect(rows[0]?.name).toBe("John Deere 350G");
  });

  it("RLS rejects moving org A equipment into org B", async () => {
    await expect(
      rawAsUser(w.pg, w.orgA.owner, `update public.equipment set organization_id = $2 where id = $1`, [
        seedA.equipmentId,
        w.orgB.id,
      ]),
    ).rejects.toThrow(/row-level security/);
  });

  it("field employees and accountants cannot mutate equipment", async () => {
    for (const user of [w.orgA.fieldEmployee, w.orgA.accountant]) {
      await expect(
        rawAsUser(
          w.pg,
          user,
          `insert into public.equipment (organization_id, name, type) values ($1, 'x', 'y')`,
          [w.orgA.id],
        ),
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("owner can create equipment and a manager can update it in their own org, audited", async () => {
    const { rows } = await rawAsUser<{ id: string }>(
      w.pg,
      w.orgA.owner,
      `insert into public.equipment (organization_id, name, type) values ($1, 'Bobcat S650', 'skid steer') returning id`,
      [w.orgA.id],
    );
    const id = (rows[0] as { id: string }).id;
    const updated = await rawAsUser(
      w.pg,
      w.orgA.manager,
      `update public.equipment set active = false where id = $1`,
      [id],
    );
    expect(updated.rowCount).toBe(1);

    expect(
      await count(w.pg, `select 1 from public.audit_log where entity_id = $1 and action = $2`, [
        id,
        "equipment.created",
      ]),
    ).toBe(1);
    expect(
      await count(w.pg, `select 1 from public.audit_log where entity_id = $1 and action = $2`, [
        id,
        "equipment.updated",
      ]),
    ).toBe(1);
  });
});

describe("M3-T02: outsiders and anonymous callers see nothing", () => {
  it("an unaffiliated authenticated user reads no equipment", async () => {
    const { rows } = await rawAsUser(w.pg, w.outsider, `select * from public.equipment`);
    expect(rows).toHaveLength(0);
  });

  it("anonymous callers are rejected outright", async () => {
    await expect(rawAsUser(w.pg, null, `select * from public.equipment`)).rejects.toThrow(
      /permission denied/,
    );
  });
});
