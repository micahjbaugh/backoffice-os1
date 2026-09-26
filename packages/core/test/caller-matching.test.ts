// M2-T08: caller matching service. Feeds M2-T09 (persisting the communication record) with the
// customer/employee a call or message belongs to.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizePhoneNumber, type Actor } from "@backoffice/domain";
import { createCustomer, createEmployee, listOrgOpsCases, matchCallerByPhone } from "../src";
import { inOrg } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const workflow: Actor = { type: "system", name: "caller-matching-test" };

beforeAll(async () => {
  w = await createWorld();
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createCustomer(ctx, { displayName: "Alice Customer", phone: "(415) 555-0142" }),
  );
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createEmployee(ctx, { displayName: "Evan Employee", phone: "415-555-0199" }),
  );
  // Same phone as Alice, but in org B: must never surface as a match in org A's context.
  await inOrg(w.db, { type: "user", userId: w.orgB.owner }, w.orgB.id, (ctx) =>
    createCustomer(ctx, { displayName: "Cross-tenant Alice", phone: "+1 415 555 0142" }),
  );
  // A second org A contact sharing a phone number, to exercise the ambiguous path.
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createCustomer(ctx, { displayName: "Shared Line Customer", phone: "415.555.0177" }),
  );
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createEmployee(ctx, { displayName: "Shared Line Employee", phone: "+14155550177" }),
  );
});
afterAll(async () => {
  await w.close();
});

describe("normalizePhoneNumber", () => {
  it("compares formatting variants as equal", () => {
    expect(normalizePhoneNumber("(415) 555-0142")).toBe(normalizePhoneNumber("+1 415 555 0142"));
    expect(normalizePhoneNumber("415-555-0142")).toBe("4155550142");
  });

  it("returns null for empty or unparseable input", () => {
    expect(normalizePhoneNumber("")).toBeNull();
    expect(normalizePhoneNumber(null)).toBeNull();
    expect(normalizePhoneNumber("ext only")).toBeNull();
  });
});

describe("matchCallerByPhone", () => {
  it("matches a single customer by phone regardless of formatting", async () => {
    const result = await inOrg(w.db, workflow, w.orgA.id, (ctx) =>
      matchCallerByPhone(ctx, "+14155550142"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.entityType).toBe("customer");
    expect(result.displayName).toBe("Alice Customer");
  });

  it("matches a single employee by phone", async () => {
    const result = await inOrg(w.db, workflow, w.orgA.id, (ctx) =>
      matchCallerByPhone(ctx, "(415) 555-0199"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.entityType).toBe("employee");
    expect(result.displayName).toBe("Evan Employee");
  });

  it("reports no_match when no contact in the org has that phone", async () => {
    const result = await inOrg(w.db, workflow, w.orgA.id, (ctx) =>
      matchCallerByPhone(ctx, "+15005550199"),
    );
    expect(result).toEqual({ status: "no_match" });
  });

  it("never matches a contact that belongs to a different organization", async () => {
    const result = await inOrg(w.db, workflow, w.orgA.id, (ctx) =>
      matchCallerByPhone(ctx, "+14155550142"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.displayName).toBe("Alice Customer");
    expect(result.displayName).not.toBe("Cross-tenant Alice");
  });

  it("opens a low_confidence ops case when more than one contact shares a phone", async () => {
    const result = await inOrg(w.db, workflow, w.orgA.id, (ctx) =>
      matchCallerByPhone(ctx, "415-555-0177"),
    );
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") throw new Error("expected ambiguous");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.entityType).sort()).toEqual(["customer", "employee"]);
    expect(result.opsCase.reasonCode).toBe("low_confidence");
    expect(result.opsCase.status).toBe("new");
    expect(result.opsCase.evidence.normalized_phone).toBe("4155550177");

    const cases = await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
      listOrgOpsCases(ctx),
    );
    expect(cases.some((c) => c.id === result.opsCase.id)).toBe(true);
  });
});
