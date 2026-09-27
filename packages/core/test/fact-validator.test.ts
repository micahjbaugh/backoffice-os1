// M3-T13: fact validator. Exercises the full validate step (ARCHITECTURE.md §4 step 5) against a
// real org: known employee/job/equipment, plausible times, duplicates, and the confidence
// threshold, each landing in the right result branch without ever writing a draft record itself.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor, FieldCaptureFact } from "@backoffice/domain";
import { createEmployee, createJob, validateFieldCaptureFact } from "../src";
import { inOrg } from "./helpers/db";
import { createWorld, type World } from "./helpers/fixtures";

let w: World;
const system: Actor = { type: "system", name: "fact-validator-test" };

function timeEntryFact(
  overrides: {
    factKey?: string;
    fields?: Partial<{ employeeRef: string; jobRef: string; startTime: string; endTime: string }>;
    confidence?: Record<string, number>;
  } = {},
): FieldCaptureFact {
  return {
    factKey: overrides.factKey ?? "time-1",
    type: "time_entry",
    fields: {
      employeeRef: "Jake Tyler",
      jobRef: "Wilson",
      startTime: "7:00",
      endTime: "5:30",
      ...overrides.fields,
    },
    confidence: overrides.confidence ?? {
      employeeRef: 0.95,
      jobRef: 0.9,
      startTime: 0.9,
      endTime: 0.9,
    },
    evidence: [{ field: "employeeRef", quote: "Me Jake Tyler 7-5:30 Wilson" }],
  };
}

function equipmentFact(
  overrides: {
    factKey?: string;
    fields?: Partial<{ equipmentRef: string; jobRef: string; hours: number }>;
    confidence?: Record<string, number>;
  } = {},
): FieldCaptureFact {
  return {
    factKey: overrides.factKey ?? "equip-1",
    type: "equipment_usage",
    fields: { equipmentRef: "Hoe", jobRef: "Wilson", hours: 8, ...overrides.fields },
    confidence: overrides.confidence ?? { equipmentRef: 0.9, hours: 0.9 },
    evidence: [{ field: "equipmentRef", quote: "Hoe 8 hrs" }],
  };
}

beforeAll(async () => {
  w = await createWorld();
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createEmployee(ctx, { displayName: "Jake Tyler" }),
  );
  await inOrg(w.db, { type: "user", userId: w.orgA.owner }, w.orgA.id, (ctx) =>
    createJob(ctx, { name: "Wilson Residence Regrade", status: "active" }),
  );
  await w.pg.query(
    `insert into public.equipment (organization_id, name, type, aliases, active)
     values ($1, 'John Deere 350G', 'excavator', array['Hoe'], true)`,
    [w.orgA.id],
  );
});
afterAll(async () => {
  await w.close();
});

describe("validateFieldCaptureFact", () => {
  it("validates a time entry: known employee, known job, plausible '7-5:30' time", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      validateFieldCaptureFact(ctx, timeEntryFact(), []),
    );
    expect(result.status).toBe("valid");
    if (result.status !== "valid") throw new Error("expected valid");
    expect(result.entities.employee?.displayName).toBe("Jake Tyler");
    expect(result.entities.job?.name).toBe("Wilson Residence Regrade");
    expect(result.hours).toBeCloseTo(10.5);
  });

  it("validates an equipment usage: known equipment, known job, given hours", async () => {
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      validateFieldCaptureFact(ctx, equipmentFact(), []),
    );
    expect(result.status).toBe("valid");
    if (result.status !== "valid") throw new Error("expected valid");
    expect(result.entities.equipment?.name).toBe("John Deere 350G");
    expect(result.hours).toBe(8);
  });

  it("needs clarification when a field's confidence is below the threshold", async () => {
    const fact = timeEntryFact({ confidence: { employeeRef: 0.3, jobRef: 0.9 } });
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      validateFieldCaptureFact(ctx, fact, []),
    );
    expect(result.status).toBe("needs_clarification");
    if (result.status !== "needs_clarification") throw new Error("expected needs_clarification");
    expect(result.reason).toBe("low_confidence");
    expect(result.opsCase.reasonCode).toBe("low_confidence");
  });

  it("needs clarification when the employee reference matches nobody active", async () => {
    const fact = timeEntryFact({ fields: { employeeRef: "Nobody" } });
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      validateFieldCaptureFact(ctx, fact, []),
    );
    expect(result.status).toBe("needs_clarification");
    if (result.status !== "needs_clarification") throw new Error("expected needs_clarification");
    expect(result.reason).toBe("unmatched_employee");
    expect(result.opsCase.reasonCode).toBe("missing_data");
  });

  it("needs clarification when the job reference matches nobody active", async () => {
    const fact = equipmentFact({ fields: { jobRef: "Nonexistent" } });
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      validateFieldCaptureFact(ctx, fact, []),
    );
    expect(result.status).toBe("needs_clarification");
    if (result.status !== "needs_clarification") throw new Error("expected needs_clarification");
    expect(result.reason).toBe("unmatched_job");
  });

  it("needs clarification when the reported time doesn't parse into a plausible shift", async () => {
    const fact = timeEntryFact({ fields: { endTime: "whenever" } });
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      validateFieldCaptureFact(ctx, fact, []),
    );
    expect(result.status).toBe("needs_clarification");
    if (result.status !== "needs_clarification") throw new Error("expected needs_clarification");
    expect(result.reason).toBe("implausible_time");
  });

  it("flags a duplicate against another fact already seen in the same extraction", async () => {
    const first = equipmentFact();
    const duplicate = equipmentFact({ factKey: "equip-1b" });
    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      validateFieldCaptureFact(ctx, duplicate, [first]),
    );
    expect(result.status).toBe("duplicate");
  });
});
