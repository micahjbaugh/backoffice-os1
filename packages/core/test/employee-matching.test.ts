// M3-T13: employee reference matching. Feeds field-capture drafting — a time entry extracted
// from a crew message must attach to exactly one employee before it can be drafted. Mirrors
// job-matching.test.ts and equipment-matching.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@backoffice/domain";
import { createEmployee, listOrgOpsCases, resolveEmployeeByReference } from "../src";
import { inOrg } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const system: Actor = { type: "system", name: "employee-matching-test" };

beforeAll(async () => {
  w = await createWorld();
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createEmployee(ctx, { displayName: "Jake Tyler" }),
  );
  // Same name, different org: must never surface as a match in org A's context.
  await inOrg(w.db, { type: "user", userId: w.orgB.owner }, w.orgB.id, (ctx) =>
    createEmployee(ctx, { displayName: "Jake Tyler" }),
  );
  // Two active org A employees sharing "Sam", to exercise the ambiguous path.
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createEmployee(ctx, { displayName: "Sam Rivera" }),
  );
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createEmployee(ctx, { displayName: "Sam Okafor" }),
  );
  // Inactive employee whose name must not match.
  const inactive = await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createEmployee(ctx, { displayName: "Former Employee" }),
  );
  await w.pg.query(`update public.employees set active = false where id = $1`, [inactive.id]);
});
afterAll(async () => {
  await w.close();
});

describe("resolveEmployeeByReference", () => {
  it("matches a single active employee by full name", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEmployeeByReference(ctx, "Jake Tyler"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.employee.displayName).toBe("Jake Tyler");
  });

  it("matches a single active employee by first name", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEmployeeByReference(ctx, "Jake"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.employee.displayName).toBe("Jake Tyler");
  });

  it("never matches an employee in a different organization", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEmployeeByReference(ctx, "Jake Tyler"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.employee.organizationId).toBe(w.orgA.id);
  });

  it("ignores an employee that is not active", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEmployeeByReference(ctx, "Former Employee"),
    );
    expect(result.status).toBe("none");
  });

  it("opens a missing_data ops case when no active employee matches", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEmployeeByReference(ctx, "Nobody Here"),
    );
    expect(result.status).toBe("none");
    if (result.status !== "none") throw new Error("expected none");
    expect(result.opsCase.reasonCode).toBe("missing_data");

    const cases = await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
      listOrgOpsCases(ctx),
    );
    expect(cases.some((c) => c.id === result.opsCase.id)).toBe(true);
  });

  it("opens a low_confidence ops case when more than one active employee matches", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveEmployeeByReference(ctx, "Sam"),
    );
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") throw new Error("expected ambiguous");
    expect(result.candidates.map((c) => c.displayName).sort()).toEqual([
      "Sam Okafor",
      "Sam Rivera",
    ]);
    expect(result.opsCase.reasonCode).toBe("low_confidence");
  });
});
