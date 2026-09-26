// M3-T06: createDraftTimeEntry. Idempotent per (organization_id, source_communication_id, fact_key)
// so replaying the crew message that produced a set of time entries creates nothing new.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "@backoffice/domain";
import { createDraftTimeEntry } from "../src";
import { inOrg, userActor } from "./helpers/db";
import { auditCount, eventCount, factRowCount, fieldCapture, seedCommunicationId, seedEmployee } from "./helpers/draft-facts";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

describe("createDraftTimeEntry", () => {
  it("persists a draft time entry with an event and trigger-written audit", async () => {
    const communicationId = await seedCommunicationId(w, w.orgA.id);
    const employeeId = await seedEmployee(w, w.orgA.id);
    const { timeEntry, created } = await inOrg(w.db, fieldCapture, w.orgA.id, (ctx) =>
      createDraftTimeEntry(ctx, {
        employeeId,
        jobId: w.orgA.job.id,
        workDate: "2026-01-05",
        hours: 10.5,
        sourceCommunicationId: communicationId,
        factKey: "time:0",
      }),
    );
    expect(created).toBe(true);
    expect(timeEntry.status).toBe("draft");
    expect(timeEntry.workDate).toBe("2026-01-05");
    expect(await eventCount(w, "time_entry.drafted", timeEntry.id)).toBe(1);
    expect(await auditCount(w, "time_entry.created", timeEntry.id)).toBe(1);
  });

  it("is idempotent per (source_communication_id, fact_key)", async () => {
    const communicationId = await seedCommunicationId(w, w.orgA.id);
    const employeeId = await seedEmployee(w, w.orgA.id);
    const input = {
      employeeId,
      jobId: w.orgA.job.id,
      workDate: "2026-01-05",
      hours: 8,
      sourceCommunicationId: communicationId,
      factKey: "time:0",
    };
    const first = await inOrg(w.db, fieldCapture, w.orgA.id, (ctx) => createDraftTimeEntry(ctx, input));
    const second = await inOrg(w.db, fieldCapture, w.orgA.id, (ctx) => createDraftTimeEntry(ctx, input));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.timeEntry.id).toBe(first.timeEntry.id);
    expect(await factRowCount(w, "time_entries", communicationId, "time:0")).toBe(1);
    expect(await eventCount(w, "time_entry.drafted", first.timeEntry.id)).toBe(1);
  });

  it("distinct fact keys under the same communication create separate rows", async () => {
    const communicationId = await seedCommunicationId(w, w.orgA.id);
    const employeeId = await seedEmployee(w, w.orgA.id);
    const a = await inOrg(w.db, fieldCapture, w.orgA.id, (ctx) =>
      createDraftTimeEntry(ctx, {
        employeeId,
        jobId: w.orgA.job.id,
        workDate: "2026-01-05",
        sourceCommunicationId: communicationId,
        factKey: "time:0",
      }),
    );
    const b = await inOrg(w.db, fieldCapture, w.orgA.id, (ctx) =>
      createDraftTimeEntry(ctx, {
        employeeId,
        jobId: w.orgA.job.id,
        workDate: "2026-01-05",
        sourceCommunicationId: communicationId,
        factKey: "time:1",
      }),
    );
    expect(a.timeEntry.id).not.toBe(b.timeEntry.id);
  });

  it("rejects an employee from a different organization", async () => {
    await expect(
      inOrg(w.db, fieldCapture, w.orgA.id, (ctx) =>
        createDraftTimeEntry(ctx, { employeeId: w.orgB.owner, jobId: w.orgA.job.id, workDate: "2026-01-05" }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a job from a different organization", async () => {
    const employeeId = await seedEmployee(w, w.orgA.id);
    await expect(
      inOrg(w.db, fieldCapture, w.orgA.id, (ctx) =>
        createDraftTimeEntry(ctx, { employeeId, jobId: w.orgB.job.id, workDate: "2026-01-05" }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("denies actors without time_entry.write, e.g. a field employee", async () => {
    const employeeId = await seedEmployee(w, w.orgA.id);
    await expect(
      inOrg(w.db, userActor(w.orgA.fieldEmployee), w.orgA.id, (ctx) =>
        createDraftTimeEntry(ctx, { employeeId, jobId: w.orgA.job.id, workDate: "2026-01-05" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
