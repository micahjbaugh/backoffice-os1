// M3-T06: draft job note service. See draft-records.ts for the shared idempotency and
// authorization rationale.

import {
  createDraftJobNoteInput,
  EVENT_TYPES,
  parseInput,
  type CreateDraftJobNoteInput,
  type JobNote,
} from "@backoffice/domain";
import { toJobNote, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { findFactKeyRow } from "./draft-fact";
import { assertCommunicationInOrg, assertEntityInOrg } from "./entities";
import { recordEvent } from "./events";

export interface CreateDraftJobNoteResult {
  jobNote: JobNote;
  created: boolean;
}

export async function createDraftJobNote(
  ctx: ServiceContext,
  input: CreateDraftJobNoteInput,
): Promise<CreateDraftJobNoteResult> {
  await ctx.authorize("job_note.write");
  const data = parseInput(createDraftJobNoteInput, input);
  await assertEntityInOrg(ctx, "job", data.jobId);
  await assertCommunicationInOrg(ctx, data.sourceCommunicationId);

  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.job_notes
       (organization_id, job_id, body, source_communication_id, confidence, evidence, fact_key)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (organization_id, source_communication_id, fact_key)
       where source_communication_id is not null and fact_key is not null do nothing
     returning *`,
    [
      ctx.organizationId,
      data.jobId,
      data.body,
      data.sourceCommunicationId ?? null,
      data.confidence,
      data.evidence,
      data.factKey ?? null,
    ],
  );

  if (!rows[0]) {
    const existing = await findFactKeyRow(
      ctx,
      "public.job_notes",
      data.sourceCommunicationId,
      data.factKey,
    );
    if (!existing) throw new Error("job note idempotency conflict without existing row");
    return { jobNote: toJobNote(existing), created: false };
  }

  const jobNote = toJobNote(rows[0]);
  await recordEvent(ctx, {
    type: EVENT_TYPES.jobNoteDrafted,
    entityType: "job_note",
    entityId: jobNote.id,
    idempotencyKey: `job_note.drafted:${jobNote.id}`,
    payload: { job_id: jobNote.jobId },
  });
  return { jobNote, created: true };
}
