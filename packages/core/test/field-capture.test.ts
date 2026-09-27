// M3-T14: field capture workflow (ARCHITECTURE.md §4). A fixture extractor drives the whole
// pipeline for one inbound message: valid facts draft, unmatched/low-confidence facts open a
// clarification instead of guessing (CLAUDE.md rule 14), duplicates and deferred billable
// opportunities are skipped, and unresolved questions get their own ops case. Replaying the same
// source communication is a full no-op: the extractor never runs again and nothing new is written.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Actor,
  FieldCaptureExtraction,
  FieldCaptureFact,
  StructuredExtractor,
  UnresolvedQuestion,
} from "@backoffice/domain";
import { createEmployee, createJob, runFieldCaptureWorkflow } from "../src";
import { count, inOrg } from "./helpers/db";
import { seedCommunicationId } from "./helpers/draft-facts";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
let jobId: string;

const system: Actor = { type: "system", name: "field-capture-test" };

class FixtureExtractor implements StructuredExtractor<FieldCaptureExtraction> {
  calls = 0;
  constructor(
    private readonly facts: FieldCaptureFact[],
    private readonly unresolvedQuestions: UnresolvedQuestion[] = [],
  ) {}
  async extract() {
    this.calls += 1;
    return {
      data: { facts: this.facts, unresolvedQuestions: this.unresolvedQuestions },
      modelVersion: "fixture-1",
    };
  }
}

function timeEntryFact(overrides: Partial<FieldCaptureFact> = {}): FieldCaptureFact {
  return {
    factKey: "time-1",
    type: "time_entry",
    fields: { employeeRef: "Jake Tyler", jobRef: "Wilson", startTime: "7:00", endTime: "5:30" },
    confidence: { employeeRef: 0.95, jobRef: 0.9, startTime: 0.9, endTime: 0.9 },
    evidence: [{ field: "employeeRef", quote: "Me Jake Tyler 7-5:30 Wilson" }],
    ...overrides,
  } as FieldCaptureFact;
}

beforeAll(async () => {
  w = await createWorld();
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createEmployee(ctx, { displayName: "Jake Tyler" }),
  );
  const job = await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createJob(ctx, { name: "Wilson Residence Regrade", status: "active" }),
  );
  jobId = job.id;
});
afterAll(async () => {
  await w.close();
});

describe("runFieldCaptureWorkflow", () => {
  it("drafts a valid fact, clarifies an unmatched one, and audits an unresolved question", async () => {
    const communicationId = await seedCommunicationId(w, w.orgA.id);
    const extractor = new FixtureExtractor(
      [
        timeEntryFact(),
        timeEntryFact({ factKey: "time-2", fields: { employeeRef: "Nobody", jobRef: "Wilson" } }),
      ],
      [{ question: "What ticket does the rock delivery belong to?", evidence: [] }],
    );

    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      runFieldCaptureWorkflow(ctx, {
        sourceCommunicationId: communicationId,
        text: "x",
        extractor,
      }),
    );

    expect(result.processed).toBe(true);
    expect(result.outcomes).toHaveLength(2);
    const [drafted, clarified] = result.outcomes;
    expect(drafted).toMatchObject({ factKey: "time-1", status: "drafted" });
    expect(clarified).toMatchObject({
      factKey: "time-2",
      status: "needs_clarification",
      reason: "unmatched_employee",
    });
    expect(result.unresolvedQuestionCaseIds).toHaveLength(1);

    expect(await count(w.pg, `select 1 from public.time_entries where job_id = $1`, [jobId])).toBe(
      1,
    );
    expect(
      await count(w.pg, `select 1 from public.ops_cases where organization_id = $1`, [w.orgA.id]),
    ).toBe(2);
    expect(extractor.calls).toBe(1);
  });

  it("skips a duplicate fact and defers a billable opportunity", async () => {
    const communicationId = await seedCommunicationId(w, w.orgA.id);
    const first = timeEntryFact({ factKey: "dup-1" });
    const duplicate = timeEntryFact({ factKey: "dup-2" });
    const opportunity: FieldCaptureFact = {
      factKey: "opp-1",
      type: "billable_opportunity",
      fields: { jobRef: "Wilson", description: "grade another 200 ft" },
      confidence: { description: 0.9 },
      evidence: [{ field: "description", quote: "grade another 200 ft" }],
    };
    const extractor = new FixtureExtractor([first, duplicate, opportunity]);

    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      runFieldCaptureWorkflow(ctx, {
        sourceCommunicationId: communicationId,
        text: "x",
        extractor,
      }),
    );

    expect(result.outcomes.map((o) => o.status)).toEqual(["drafted", "duplicate", "deferred"]);
  });

  it("replaying the same source communication creates nothing new", async () => {
    const communicationId = await seedCommunicationId(w, w.orgA.id);
    const factKey = `replay-${randomUUID()}`;
    const extractor = new FixtureExtractor([timeEntryFact({ factKey })]);

    const first = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      runFieldCaptureWorkflow(ctx, {
        sourceCommunicationId: communicationId,
        text: "x",
        extractor,
      }),
    );
    expect(first.processed).toBe(true);

    const timeEntriesBefore = await count(
      w.pg,
      `select 1 from public.time_entries where source_communication_id = $1`,
      [communicationId],
    );
    const opsCasesBefore = await count(
      w.pg,
      `select 1 from public.ops_cases where organization_id = $1`,
      [w.orgA.id],
    );

    const replay = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      runFieldCaptureWorkflow(ctx, {
        sourceCommunicationId: communicationId,
        text: "x",
        extractor,
      }),
    );

    expect(replay).toEqual({ processed: false, outcomes: [], unresolvedQuestionCaseIds: [] });
    expect(extractor.calls).toBe(1);
    expect(
      await count(w.pg, `select 1 from public.time_entries where source_communication_id = $1`, [
        communicationId,
      ]),
    ).toBe(timeEntriesBefore);
    expect(
      await count(w.pg, `select 1 from public.ops_cases where organization_id = $1`, [w.orgA.id]),
    ).toBe(opsCasesBefore);
  });
});
