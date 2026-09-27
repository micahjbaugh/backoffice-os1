// M3-T15: createBillableOpportunity (scope-change detection). Idempotent per
// (organization_id, source_communication_id, fact_key), exactly like the other draft services
// (M3-T06), so replaying the crew message that reported extra work creates nothing new.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "@backoffice/domain";
import { createBillableOpportunity } from "../src";
import { inOrg, userActor } from "./helpers/db";
import { eventCount, fieldCapture, seedCommunicationId } from "./helpers/draft-facts";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

describe("createBillableOpportunity", () => {
  it("persists an open billable opportunity with an event and is idempotent per (source_communication_id, fact_key)", async () => {
    const communicationId = await seedCommunicationId(w, w.orgA.id);
    const input = {
      jobId: w.orgA.job.id,
      description: "grade another 200 ft",
      quantity: 200,
      unit: "ft",
      sourceCommunicationId: communicationId,
      factKey: "opp:0",
    };
    const first = await inOrg(w.db, fieldCapture, w.orgA.id, (ctx) =>
      createBillableOpportunity(ctx, input),
    );
    const second = await inOrg(w.db, fieldCapture, w.orgA.id, (ctx) =>
      createBillableOpportunity(ctx, input),
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.billableOpportunity.id).toBe(first.billableOpportunity.id);
    expect(first.billableOpportunity.status).toBe("open");
    expect(await eventCount(w, "billable_opportunity.created", first.billableOpportunity.id)).toBe(
      1,
    );
  });

  it("rejects a job from a different organization", async () => {
    await expect(
      inOrg(w.db, fieldCapture, w.orgA.id, (ctx) =>
        createBillableOpportunity(ctx, { jobId: w.orgB.job.id, description: "wrong org" }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("denies actors without billable_opportunity.write, e.g. a field employee", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
        createBillableOpportunity(ctx, { jobId: w.orgA.job.id, description: "extra work" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
