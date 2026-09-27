// M3-T14: turn one validated field-capture fact (M3-T13's "valid" result) into the matching draft
// record. Every draft table's job_id is NOT NULL (0007/0008/0009), but a fact's jobRef is optional
// in the extraction schema — a "valid" fact can still have no resolved job, so this opens a
// clarification instead of guessing which job a draft belongs to (CLAUDE.md rule 14), the same way
// M3-T11/T12/T13's own matchers do. Used only by ./field-capture.ts (the orchestrating workflow).

import { type FieldCaptureFact, type FieldCaptureFactType, type UUID } from "@backoffice/domain";
import type { ServiceContext } from "../runtime";
import { createBillableOpportunity } from "./billable-opportunities";
import { createDraftEquipmentUsage } from "./equipment-usage";
import { createDraftTimeEntry } from "./draft-records";
import type { FactClarificationReason, ResolvedFactEntities } from "./fact-validator";
import { createDraftJobNote } from "./job-notes";
import { createDraftMaterialUsage } from "./material-usage";
import { createOpsCase } from "./ops";

export type FieldCaptureFactOutcome =
  | {
      factKey: string;
      type: FieldCaptureFactType;
      status: "drafted";
      recordId: UUID;
      created: boolean;
    }
  | {
      factKey: string;
      type: FieldCaptureFactType;
      status: "needs_clarification";
      reason: FactClarificationReason;
      opsCaseId: UUID;
    }
  | { factKey: string; type: FieldCaptureFactType; status: "duplicate" };

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The date a crew report was about: the extracted date if it parses, else the calendar date (in
 *  the org's own timezone) of the message that reported it — a crew text with no date is about
 *  today's work, never a guessed one. */
async function resolveWorkDate(
  ctx: ServiceContext,
  sourceCommunicationId: UUID,
  explicit: string | undefined,
): Promise<string> {
  if (explicit && CALENDAR_DATE_RE.test(explicit)) return explicit;
  const { rows } = await ctx.tx.asService<{ work_date: string }>(
    `select (c.started_at at time zone o.timezone)::date as work_date
       from public.communications c
       join public.organizations o on o.id = c.organization_id
      where c.id = $1 and c.organization_id = $2`,
    [sourceCommunicationId, ctx.organizationId],
  );
  const workDate = rows[0]?.work_date;
  if (!workDate)
    throw new Error(`cannot resolve work date for communication ${sourceCommunicationId}`);
  return workDate;
}

function draftFactFields(sourceCommunicationId: UUID, fact: FieldCaptureFact) {
  return {
    sourceCommunicationId,
    factKey: fact.factKey,
    confidence: fact.confidence,
    evidence: { spans: fact.evidence },
  };
}

/** Every drafted fact type needs a job; a fact the validator resolved without one (jobRef was
 *  optional in extraction) can't become a draft row (job_id is NOT NULL) — clarify instead. */
async function missingJobOutcome(
  ctx: ServiceContext,
  fact: FieldCaptureFact,
): Promise<FieldCaptureFactOutcome> {
  const opsCase = await createOpsCase(ctx, {
    title: `No job reference for "${fact.factKey}"`,
    reasonCode: "missing_data",
    priority: "normal",
    evidence: { fact_key: fact.factKey, fact_type: fact.type },
  });
  return {
    factKey: fact.factKey,
    type: fact.type,
    status: "needs_clarification",
    reason: "unmatched_job",
    opsCaseId: opsCase.id,
  };
}

/** Dispatch one validated fact to its draft-creation service, by type. */
export async function draftForFact(
  ctx: ServiceContext,
  sourceCommunicationId: UUID,
  fact: FieldCaptureFact,
  entities: ResolvedFactEntities,
  hours: number | undefined,
): Promise<FieldCaptureFactOutcome> {
  const common = draftFactFields(sourceCommunicationId, fact);

  if (fact.type === "time_entry") {
    if (!entities.job) return missingJobOutcome(ctx, fact);
    // Never actually missing here: a "valid" time_entry result always resolved an employee
    // (fact-validator returns "needs_clarification" otherwise) — checked to satisfy strict TS.
    if (!entities.employee)
      throw new Error(`valid time_entry fact ${fact.factKey} has no employee`);
    const workDate = await resolveWorkDate(ctx, sourceCommunicationId, fact.fields.workDate);
    const { timeEntry, created } = await createDraftTimeEntry(ctx, {
      ...common,
      employeeId: entities.employee.id,
      jobId: entities.job.id,
      workDate,
      hours,
    });
    return {
      factKey: fact.factKey,
      type: fact.type,
      status: "drafted",
      recordId: timeEntry.id,
      created,
    };
  }

  if (fact.type === "equipment_usage") {
    if (!entities.job) return missingJobOutcome(ctx, fact);
    // Never actually missing here: a "valid" equipment_usage result always resolved equipment.
    if (!entities.equipment)
      throw new Error(`valid equipment_usage fact ${fact.factKey} has no equipment`);
    const { equipmentUsage, created } = await createDraftEquipmentUsage(ctx, {
      ...common,
      equipmentId: entities.equipment.id,
      jobId: entities.job.id,
      hours,
    });
    return {
      factKey: fact.factKey,
      type: fact.type,
      status: "drafted",
      recordId: equipmentUsage.id,
      created,
    };
  }

  if (fact.type === "material_usage") {
    if (!entities.job) return missingJobOutcome(ctx, fact);
    const { materialUsage, created } = await createDraftMaterialUsage(ctx, {
      ...common,
      jobId: entities.job.id,
      description: fact.fields.description,
      quantity: fact.fields.quantity,
      unit: fact.fields.unit,
    });
    return {
      factKey: fact.factKey,
      type: fact.type,
      status: "drafted",
      recordId: materialUsage.id,
      created,
    };
  }

  if (fact.type === "job_note") {
    if (!entities.job) return missingJobOutcome(ctx, fact);
    const { jobNote, created } = await createDraftJobNote(ctx, {
      ...common,
      jobId: entities.job.id,
      body: fact.fields.body,
    });
    return {
      factKey: fact.factKey,
      type: fact.type,
      status: "drafted",
      recordId: jobNote.id,
      created,
    };
  }

  // billable_opportunity: a possible scope change (M3-T15) — open for the owner to review, never
  // auto-approved (CLAUDE.md rule 5-6).
  if (!entities.job) return missingJobOutcome(ctx, fact);
  const { billableOpportunity, created } = await createBillableOpportunity(ctx, {
    ...common,
    jobId: entities.job.id,
    description: fact.fields.description,
    quantity: fact.fields.quantity,
    unit: fact.fields.unit,
  });
  return {
    factKey: fact.factKey,
    type: fact.type,
    status: "drafted",
    recordId: billableOpportunity.id,
    created,
  };
}
