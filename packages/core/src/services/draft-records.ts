// M3-T06: draft time entry service for the Field Capture Agent (MASTER_SPEC §C, GREEN action).
// One crew message can yield several time entries, so each is idempotent on (organization_id,
// source_communication_id, fact_key) rather than a single per-call key: replaying the same message
// creates nothing new (0010_draft_record_idempotency.sql). Like leads, this is a staff-only
// client-writable table — field employees get no direct table access, so review always happens
// through an authorized path, never an AI prompt (CLAUDE.md rule 4). Row audit is written by DB
// trigger (time_entries_audit, 0007_time_entries.sql); the service adds the event.
// Siblings: equipment-usage.ts, material-usage.ts, job-notes.ts.

import {
  createDraftTimeEntryInput,
  EVENT_TYPES,
  parseInput,
  type CreateDraftTimeEntryInput,
  type TimeEntry,
} from "@backoffice/domain";
import { toTimeEntry, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { findFactKeyRow } from "./draft-fact";
import { assertCommunicationInOrg, assertEntityInOrg } from "./entities";
import { recordEvent } from "./events";

export interface CreateDraftTimeEntryResult {
  timeEntry: TimeEntry;
  /** False when (source_communication_id, fact_key) matched an existing row (nothing new written). */
  created: boolean;
}

export async function createDraftTimeEntry(
  ctx: ServiceContext,
  input: CreateDraftTimeEntryInput,
): Promise<CreateDraftTimeEntryResult> {
  await ctx.authorize("time_entry.write");
  const data = parseInput(createDraftTimeEntryInput, input);
  await assertEntityInOrg(ctx, "employee", data.employeeId);
  await assertEntityInOrg(ctx, "job", data.jobId);
  await assertCommunicationInOrg(ctx, data.sourceCommunicationId);

  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.time_entries
       (organization_id, employee_id, job_id, work_date, start_at, end_at, hours,
        source_communication_id, confidence, evidence, fact_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (organization_id, source_communication_id, fact_key)
       where source_communication_id is not null and fact_key is not null do nothing
     returning *`,
    [
      ctx.organizationId,
      data.employeeId,
      data.jobId,
      data.workDate,
      data.startAt ?? null,
      data.endAt ?? null,
      data.hours ?? null,
      data.sourceCommunicationId ?? null,
      data.confidence,
      data.evidence,
      data.factKey ?? null,
    ],
  );

  if (!rows[0]) {
    const existing = await findFactKeyRow(ctx, "public.time_entries", data.sourceCommunicationId, data.factKey);
    if (!existing) throw new Error("time entry idempotency conflict without existing row");
    return { timeEntry: toTimeEntry(existing), created: false };
  }

  const timeEntry = toTimeEntry(rows[0]);
  await recordEvent(ctx, {
    type: EVENT_TYPES.timeEntryDrafted,
    entityType: "time_entry",
    entityId: timeEntry.id,
    idempotencyKey: `time_entry.drafted:${timeEntry.id}`,
    payload: { job_id: timeEntry.jobId, employee_id: timeEntry.employeeId, hours: timeEntry.hours },
  });
  return { timeEntry, created: true };
}
