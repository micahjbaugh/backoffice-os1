// M3-T18: end-to-end acceptance test for the M3 (Field Capture) milestone (MILESTONES.md). Drives
// the exact acceptance input through the real pipeline — job/equipment matching (M3-T11/T12),
// fact validation (M3-T13), the field capture workflow (M3-T14), scope-change detection (M3-T15)
// and the owner-inbox list services (M3-T17) — with the deterministic fixture extractor (M3-T09)
// standing in for the LLM adapter (M3-T10). Every MILESTONES.md bullet gets its own assertion:
// drafts for every fact type, the low-confidence time entry staying a clarification instead of a
// guess, the owner's inbox showing only that clarification and the billable opportunity, and a
// replay creating nothing new.

import {
  FIELD_CAPTURE_ACCEPTANCE_MESSAGE,
  FixtureStructuredExtractor,
} from "@backoffice/integrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor, UUID } from "@backoffice/domain";
import {
  createEmployee,
  createJob,
  listOpenBillableOpportunities,
  listOrgOpsCases,
  listPendingApprovals,
  runFieldCaptureWorkflow,
} from "@backoffice/core";
import { count, inOrg } from "../../core/test/helpers/db";
import { seedCommunicationId } from "../../core/test/helpers/draft-facts";
import { createWorld, type World } from "../../core/test/helpers/fixtures";

let w: World;
let jobId: UUID;

const system: Actor = { type: "system", name: "m3-acceptance-test" };
const owner = (): Actor => ({ type: "user", userId: w.orgA.owner });

/** `text[]` literal for hardcoded fixture aliases (no user input, so no escaping needed). */
function aliasLiteral(aliases: string[]): string {
  return `array[${aliases.map((a) => `'${a}'`).join(",")}]`;
}

async function seedEquipment(fields: { name: string; type: string; aliases: string[] }) {
  await w.pg.query(
    `insert into public.equipment (organization_id, name, type, aliases)
     values ($1, $2, $3, ${aliasLiteral(fields.aliases)})`,
    [w.orgA.id, fields.name, fields.type],
  );
}

beforeAll(async () => {
  w = await createWorld();
  await inOrg(w.db, owner(), w.orgA.id, (ctx) =>
    createEmployee(ctx, { displayName: "Jake Tyler" }),
  );
  const job = await inOrg(w.db, owner(), w.orgA.id, (ctx) =>
    createJob(ctx, { name: "Wilson Residence Regrade", status: "active" }),
  );
  jobId = job.id;
  await seedEquipment({ name: "John Deere 350G", type: "excavator", aliases: ["Hoe"] });
  await seedEquipment({ name: "Cat D6 Dozer", type: "dozer", aliases: ["D6"] });
});
afterAll(async () => {
  await w.close();
});

describe("M3 acceptance: field capture", () => {
  it("runs the MILESTONES.md acceptance input through the workflow with the fixture extractor", async () => {
    const communicationId = await seedCommunicationId(w, w.orgA.id);
    const extractor = new FixtureStructuredExtractor();

    const result = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      runFieldCaptureWorkflow(ctx, {
        sourceCommunicationId: communicationId,
        text: FIELD_CAPTURE_ACCEPTANCE_MESSAGE,
        extractor,
      }),
    );

    expect(result.processed).toBe(true);
    expect(result.outcomes.map((o) => ({ factKey: o.factKey, status: o.status }))).toEqual([
      { factKey: "time-1", status: "needs_clarification" },
      { factKey: "equip-1", status: "drafted" },
      { factKey: "equip-2", status: "drafted" },
      { factKey: "material-1", status: "drafted" },
      { factKey: "note-1", status: "drafted" },
      { factKey: "billable-1", status: "drafted" },
    ]);
    expect(result.unresolvedQuestionCaseIds).toHaveLength(0);

    // The one low-confidence fact (time entry, jobRef confidence 0.6 < the 0.65 threshold) never
    // becomes a guessed draft: it stops at validation and opens a clarification instead (CLAUDE.md
    // rule 14).
    const [timeOutcome] = result.outcomes;
    if (timeOutcome?.status !== "needs_clarification") throw new Error("expected clarification");
    expect(timeOutcome.reason).toBe("low_confidence");
    expect(await count(w.pg, `select 1 from public.time_entries where job_id = $1`, [jobId])).toBe(
      0,
    );

    // Every other fact type drafted, attached to the matched job.
    expect(
      await count(w.pg, `select 1 from public.equipment_usages where job_id = $1`, [jobId]),
    ).toBe(2);
    expect(
      await count(w.pg, `select 1 from public.material_usages where job_id = $1`, [jobId]),
    ).toBe(1);
    expect(await count(w.pg, `select 1 from public.job_notes where job_id = $1`, [jobId])).toBe(1);

    // The scope-change fact drafted as an open billable opportunity for the owner to decide, not
    // auto-approved (CLAUDE.md rules 5-6).
    const billableOutcome = result.outcomes.find((o) => o.factKey === "billable-1");
    if (billableOutcome?.status !== "drafted") throw new Error("expected billable to draft");
    expect(
      await count(
        w.pg,
        `select 1 from public.billable_opportunities where id = $1 and status = 'open' and job_id = $2`,
        [billableOutcome.recordId, jobId],
      ),
    ).toBe(1);

    // Exactly one clarification opened for the whole message (the low-confidence time entry) —
    // the four validly-matched, high-confidence facts never touch ops_cases at all.
    expect(
      await count(w.pg, `select 1 from public.ops_cases where organization_id = $1`, [w.orgA.id]),
    ).toBe(1);

    // Owner inbox: only the clarification and the billable opportunity need the owner, nothing
    // else. No approval was ever created by field capture.
    const approvals = await inOrg(w.db, owner(), w.orgA.id, (ctx) => listPendingApprovals(ctx));
    expect(approvals).toEqual([]);

    const billables = await inOrg(w.db, owner(), w.orgA.id, (ctx) =>
      listOpenBillableOpportunities(ctx),
    );
    expect(billables.map((b) => b.id)).toEqual([billableOutcome.recordId]);

    const openCases = (await inOrg(w.db, owner(), w.orgA.id, (ctx) => listOrgOpsCases(ctx))).filter(
      (c) => c.status !== "resolved" && c.status !== "closed",
    );
    expect(openCases).toHaveLength(1);
    expect(openCases[0]?.id).toBe(timeOutcome.opsCaseId);
    expect(openCases[0]?.reasonCode).toBe("low_confidence");

    // Replaying the same inbound message creates nothing new (CLAUDE.md rule 7: idempotent side
    // effects) — not a second clarification, not a second draft, not a second billable
    // opportunity, and the extractor never runs again.
    const replayExtractor = new FixtureStructuredExtractor();
    const replay = await inOrg(w.db, system, w.orgA.id, (ctx) =>
      runFieldCaptureWorkflow(ctx, {
        sourceCommunicationId: communicationId,
        text: FIELD_CAPTURE_ACCEPTANCE_MESSAGE,
        extractor: replayExtractor,
      }),
    );
    expect(replay).toEqual({ processed: false, outcomes: [], unresolvedQuestionCaseIds: [] });

    expect(
      await count(w.pg, `select 1 from public.equipment_usages where job_id = $1`, [jobId]),
    ).toBe(2);
    expect(
      await count(w.pg, `select 1 from public.material_usages where job_id = $1`, [jobId]),
    ).toBe(1);
    expect(await count(w.pg, `select 1 from public.job_notes where job_id = $1`, [jobId])).toBe(1);
    expect(
      await count(w.pg, `select 1 from public.billable_opportunities where job_id = $1`, [jobId]),
    ).toBe(1);
    expect(
      await count(w.pg, `select 1 from public.ops_cases where organization_id = $1`, [w.orgA.id]),
    ).toBe(1);
  });
});
