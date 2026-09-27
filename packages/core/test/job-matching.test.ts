// M3-T11: job reference matching. Feeds field-capture drafting — a time entry, equipment usage
// etc. extracted from a crew message must attach to exactly one job before it can be drafted.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@backoffice/domain";
import { createCustomer, createJob, listOrgOpsCases, resolveJobByReference } from "../src";
import { inOrg } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const system: Actor = { type: "system", name: "job-matching-test" };

beforeAll(async () => {
  w = await createWorld();
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createJob(ctx, { name: "Wilson Residence Regrade", status: "active" }),
  );
  // Same name fragment, different org: must never surface as a match in org A's context.
  await inOrg(w.db, { type: "user", userId: w.orgB.owner }, w.orgB.id, (ctx) =>
    createJob(ctx, { name: "Wilson Driveway", status: "active" }),
  );
  // Matches by customer name rather than job name.
  const customer = await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createCustomer(ctx, { displayName: "Tyler Farms" }),
  );
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createJob(ctx, { name: "North Field", customerId: customer.id, status: "active" }),
  );
  // Two active jobs sharing "Smith", to exercise the ambiguous path.
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createJob(ctx, { name: "Smith Ave Culvert", status: "active" }),
  );
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createJob(ctx, { name: "Smith Park Grading", status: "active" }),
  );
  // Not-yet-active job whose name must not match.
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createJob(ctx, { name: "Draft Pending Job" }),
  );
});
afterAll(async () => {
  await w.close();
});

describe("resolveJobByReference", () => {
  it("matches a single active job by job name", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveJobByReference(ctx, "Wilson"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.job.name).toBe("Wilson Residence Regrade");
  });

  it("never matches a job in a different organization", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveJobByReference(ctx, "Wilson"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.job.name).not.toBe("Wilson Driveway");
  });

  it("matches a single active job by customer name", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveJobByReference(ctx, "Tyler"),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected matched");
    expect(result.job.name).toBe("North Field");
  });

  it("ignores a job that is not active", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveJobByReference(ctx, "Draft Pending"),
    );
    expect(result.status).toBe("none");
  });

  it("opens a missing_data ops case when no active job matches", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveJobByReference(ctx, "Nonexistent Ranch"),
    );
    expect(result.status).toBe("none");
    if (result.status !== "none") throw new Error("expected none");
    expect(result.opsCase.reasonCode).toBe("missing_data");

    const cases = await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
      listOrgOpsCases(ctx),
    );
    expect(cases.some((c) => c.id === result.opsCase.id)).toBe(true);
  });

  it("opens a low_confidence ops case when more than one active job matches", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      resolveJobByReference(ctx, "Smith"),
    );
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") throw new Error("expected ambiguous");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.name).sort()).toEqual([
      "Smith Ave Culvert",
      "Smith Park Grading",
    ]);
    expect(result.opsCase.reasonCode).toBe("low_confidence");
    expect(result.opsCase.status).toBe("new");

    const cases = await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
      listOrgOpsCases(ctx),
    );
    expect(cases.some((c) => c.id === result.opsCase.id)).toBe(true);
  });
});
