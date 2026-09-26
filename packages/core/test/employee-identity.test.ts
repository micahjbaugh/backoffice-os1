// M3-T01: employee phone identity lookup. Feeds field-capture message attribution — the system
// must know exactly which employee sent an inbound report before drafting time entries from it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@backoffice/domain";
import { createEmployee, listOrgOpsCases, resolveEmployeeByPhone } from "../src";
import { inOrg } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const system: Actor = { type: "system", name: "employee-identity-test" };

beforeAll(async () => {
  w = await createWorld();
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createEmployee(ctx, { displayName: "Jake Tyler", phone: "415-555-0142" }),
  );
  // Same phone as Jake, different org: must never surface as a match in org A's context.
  await inOrg(w.db, { type: "user", userId: w.orgB.owner }, w.orgB.id, (ctx) =>
    createEmployee(ctx, { displayName: "Cross-tenant Jake", phone: "+1 415 555 0142" }),
  );
  // Two active org A employees sharing a line, to exercise the ambiguous path.
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createEmployee(ctx, { displayName: "Shared Line One", phone: "415.555.0177" }),
  );
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createEmployee(ctx, { displayName: "Shared Line Two", phone: "+14155550177" }),
  );
  // Inactive employee whose number must not match, and must not count toward ambiguity either.
  const inactive = await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createEmployee(ctx, { displayName: "Former Employee", phone: "415-555-0188" }),
  );
  await w.pg.query(`update public.employees set active = false where id = $1`, [inactive.id]);
});
afterAll(async () => {
  await w.close();
});

describe("resolveEmployeeByPhone", () => {
  it("matches a single active employee regardless of formatting", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEmployeeByPhone(ctx, "+14155550142"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.employee.displayName).toBe("Jake Tyler");
  });

  it("never matches an employee in a different organization", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEmployeeByPhone(ctx, "+14155550142"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.employee.displayName).not.toBe("Cross-tenant Jake");
  });

  it("opens a missing_data ops case for an unparseable number", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) => resolveEmployeeByPhone(ctx, "junk"));
    expect(result.status).toBe("unknown");
    if (result.status !== "unknown") throw new Error("expected unknown");
    expect(result.opsCase.reasonCode).toBe("missing_data");
    expect(result.opsCase.evidence.normalized_phone).toBeNull();

    const cases = await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
      listOrgOpsCases(ctx),
    );
    expect(cases.some((c) => c.id === result.opsCase.id)).toBe(true);
  });

  it("opens a missing_data ops case when no active employee has that number", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEmployeeByPhone(ctx, "+15005550199"),
    );
    expect(result.status).toBe("unknown");
    if (result.status !== "unknown") throw new Error("expected unknown");
    expect(result.opsCase.reasonCode).toBe("missing_data");
  });

  it("treats a deactivated employee's number as unknown, not a match", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEmployeeByPhone(ctx, "415-555-0188"),
    );
    expect(result.status).toBe("unknown");
  });

  it("opens a low_confidence ops case when more than one active employee shares a number", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEmployeeByPhone(ctx, "415-555-0177"),
    );
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") throw new Error("expected ambiguous");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.displayName).sort()).toEqual([
      "Shared Line One",
      "Shared Line Two",
    ]);
    expect(result.opsCase.reasonCode).toBe("low_confidence");
    expect(result.opsCase.status).toBe("new");

    const cases = await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
      listOrgOpsCases(ctx),
    );
    expect(cases.some((c) => c.id === result.opsCase.id)).toBe(true);
  });
});
