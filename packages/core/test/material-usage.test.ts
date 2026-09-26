// M3-T06: createDraftMaterialUsage. Idempotent per (organization_id, source_communication_id,
// fact_key) so replaying the crew message that produced a usage draft creates nothing new.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "@backoffice/domain";
import { createDraftMaterialUsage } from "../src";
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

describe("createDraftMaterialUsage", () => {
  it("persists a draft usage with an event and is idempotent per (source_communication_id, fact_key)", async () => {
    const communicationId = await seedCommunicationId(w, w.orgA.id);
    const input = {
      jobId: w.orgA.job.id,
      description: "21 ton rock",
      quantity: 21,
      unit: "ton",
      sourceCommunicationId: communicationId,
      factKey: "material:0",
    };
    const first = await inOrg(w.db, fieldCapture, w.orgA.id, (ctx) => createDraftMaterialUsage(ctx, input));
    const second = await inOrg(w.db, fieldCapture, w.orgA.id, (ctx) => createDraftMaterialUsage(ctx, input));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.materialUsage.id).toBe(first.materialUsage.id);
    expect(await eventCount(w, "material_usage.drafted", first.materialUsage.id)).toBe(1);
  });

  it("rejects a job from a different organization", async () => {
    await expect(
      inOrg(w.db, fieldCapture, w.orgA.id, (ctx) =>
        createDraftMaterialUsage(ctx, { jobId: w.orgB.job.id, description: "wrong org" }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("denies actors without material_usage.write, e.g. a field employee", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
        createDraftMaterialUsage(ctx, { jobId: w.orgA.job.id, description: "rock" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
