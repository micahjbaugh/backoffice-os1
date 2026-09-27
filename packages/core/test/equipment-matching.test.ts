// M3-T12: equipment reference matching. Feeds field-capture drafting — an equipment usage
// extracted from a crew message must attach to exactly one equipment record before it can be
// drafted. Mirrors job-matching.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor, UUID } from "@backoffice/domain";
import { listOrgOpsCases, resolveEquipmentByReference } from "../src";
import { inOrg } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const system: Actor = { type: "system", name: "equipment-matching-test" };

/** `text[]` literal for hardcoded fixture aliases (no user input, so no escaping needed). */
function aliasLiteral(aliases: string[]): string {
  return `array[${aliases.map((a) => `'${a}'`).join(",")}]`;
}

async function seedEquipment(
  w: World,
  orgId: UUID,
  fields: { name: string; type: string; aliases?: string[]; active?: boolean },
): Promise<void> {
  await w.pg.query(
    `insert into public.equipment (organization_id, name, type, aliases, active)
     values ($1, $2, $3, ${aliasLiteral(fields.aliases ?? [])}, $4)`,
    [orgId, fields.name, fields.type, fields.active ?? true],
  );
}

beforeAll(async () => {
  w = await createWorld();
  await seedEquipment(w, w.orgA.id, {
    name: "John Deere 350G",
    type: "excavator",
    aliases: ["Hoe", "excavator"],
  });
  await seedEquipment(w, w.orgA.id, {
    name: "Cat D6 Dozer",
    type: "dozer",
    aliases: ["D6", "dozer"],
  });
  // Same alias, different org: must never surface as a match in org A's context.
  await seedEquipment(w, w.orgB.id, {
    name: "Backhoe Attachment",
    type: "attachment",
    aliases: ["Hoe"],
  });
  // Two active pieces of equipment sharing the "Loader" alias, to exercise the ambiguous path.
  await seedEquipment(w, w.orgA.id, {
    name: "Cat 950 Loader",
    type: "loader",
    aliases: ["Loader"],
  });
  await seedEquipment(w, w.orgA.id, {
    name: "Bobcat S650",
    type: "skid steer",
    aliases: ["Loader", "skid steer"],
  });
  // Inactive equipment whose name/alias must not match.
  await seedEquipment(w, w.orgA.id, {
    name: "Retired Grader",
    type: "grader",
    aliases: ["Grader"],
    active: false,
  });
});
afterAll(async () => {
  await w.close();
});

describe("resolveEquipmentByReference", () => {
  it("matches a single active equipment by name", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEquipmentByReference(ctx, "John Deere"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.equipment.name).toBe("John Deere 350G");
  });

  it("matches a single active equipment by alias", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEquipmentByReference(ctx, "Hoe"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.equipment.name).toBe("John Deere 350G");
  });

  it("matches a single active equipment by a short alias like D6", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEquipmentByReference(ctx, "D6"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.equipment.name).toBe("Cat D6 Dozer");
  });

  it("never matches equipment in a different organization", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEquipmentByReference(ctx, "Hoe"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.equipment.name).not.toBe("Backhoe Attachment");
  });

  it("ignores equipment that is not active", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEquipmentByReference(ctx, "Grader"),
    );
    expect(result.status).toBe("none");
  });

  it("opens a missing_data ops case when no active equipment matches", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEquipmentByReference(ctx, "Nonexistent Crane"),
    );
    expect(result.status).toBe("none");
    if (result.status !== "none") throw new Error("expected none");
    expect(result.opsCase.reasonCode).toBe("missing_data");

    const cases = await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
      listOrgOpsCases(ctx),
    );
    expect(cases.some((c) => c.id === result.opsCase.id)).toBe(true);
  });

  it("opens a low_confidence ops case when more than one active equipment matches", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEquipmentByReference(ctx, "Loader"),
    );
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") throw new Error("expected ambiguous");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.name).sort()).toEqual(["Bobcat S650", "Cat 950 Loader"]);
    expect(result.opsCase.reasonCode).toBe("low_confidence");
    expect(result.opsCase.status).toBe("new");

    const cases = await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
      listOrgOpsCases(ctx),
    );
    expect(cases.some((c) => c.id === result.opsCase.id)).toBe(true);
  });
});
