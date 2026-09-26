// M3-T06: createDraftJobNote. Idempotent per (organization_id, source_communication_id, fact_key)
// so replaying the crew message that produced a note creates nothing new.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "@backoffice/domain";
import { createDraftJobNote } from "../src";
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

describe("createDraftJobNote", () => {
  it("persists a draft job note with an event and is idempotent per (source_communication_id, fact_key)", async () => {
    const communicationId = await seedCommunicationId(w, w.orgA.id);
    const input = {
      jobId: w.orgA.job.id,
      body: "Customer had us grade another 200 ft.",
      sourceCommunicationId: communicationId,
      factKey: "note:0",
    };
    const first = await inOrg(w.db, fieldCapture, w.orgA.id, (ctx) => createDraftJobNote(ctx, input));
    const second = await inOrg(w.db, fieldCapture, w.orgA.id, (ctx) => createDraftJobNote(ctx, input));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.jobNote.id).toBe(first.jobNote.id);
    expect(await eventCount(w, "job_note.drafted", first.jobNote.id)).toBe(1);
  });

  it("rejects a job from a different organization", async () => {
    await expect(
      inOrg(w.db, fieldCapture, w.orgA.id, (ctx) => createDraftJobNote(ctx, { jobId: w.orgB.job.id, body: "wrong org" })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("denies actors without job_note.write, e.g. a field employee", async () => {
    await expect(
      inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
        createDraftJobNote(ctx, { jobId: w.orgA.job.id, body: "note" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
