// M3-T06: createDraftEquipmentUsage. Idempotent per (organization_id, source_communication_id,
// fact_key) so replaying the crew message that produced a usage draft creates nothing new.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "@backoffice/domain";
import { createDraftEquipmentUsage } from "../src";
import { inOrg, userActor } from "./helpers/db";
import { eventCount, fieldCapture, seedCommunicationId, seedEquipment } from "./helpers/draft-facts";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
let equipmentId: string;

beforeAll(async () => {
  w = await createWorld();
  equipmentId = await seedEquipment(w, w.orgA.id);
});
afterAll(async () => {
  await w.close();
});

describe("createDraftEquipmentUsage", () => {
  it("persists a draft usage with an event and is idempotent per (source_communication_id, fact_key)", async () => {
    const communicationId = await seedCommunicationId(w, w.orgA.id);
    const input = {
      equipmentId,
      jobId: w.orgA.job.id,
      hours: 8,
      sourceCommunicationId: communicationId,
      factKey: "equipment:0",
    };
    const first = await inOrg(w.db, fieldCapture, w.orgA.id, (ctx) => createDraftEquipmentUsage(ctx, input));
    const second = await inOrg(w.db, fieldCapture, w.orgA.id, (ctx) => createDraftEquipmentUsage(ctx, input));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.equipmentUsage.id).toBe(first.equipmentUsage.id);
    expect(await eventCount(w, "equipment_usage.drafted", first.equipmentUsage.id)).toBe(1);
  });

  it("rejects equipment from a different organization", async () => {
    const otherOrgEquipmentId = await seedEquipment(w, w.orgB.id);
    await expect(
      inOrg(w.db, fieldCapture, w.orgA.id, (ctx) =>
        createDraftEquipmentUsage(ctx, { equipmentId: otherOrgEquipmentId, jobId: w.orgA.job.id }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a job from a different organization", async () => {
    await expect(
      inOrg(w.db, fieldCapture, w.orgA.id, (ctx) =>
        createDraftEquipmentUsage(ctx, { equipmentId, jobId: w.orgB.job.id }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("denies actors without equipment_usage.write, e.g. a field employee", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
        createDraftEquipmentUsage(ctx, { equipmentId, jobId: w.orgA.job.id }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
