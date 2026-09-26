// M2-T14: record the outcome/disposition of an ended call. A call-ended webhook can be delivered
// more than once (webhook_receipts, M2-T06, only blocks a byte-identical duplicate HTTP delivery,
// not a provider retry with a fresh event id for the same call), so this keys its own business
// event off the caller-supplied `providerEventId` and skips the mutation entirely on replay.

import {
  EVENT_TYPES,
  NotFoundError,
  parseInput,
  recordCallDispositionInput,
  type Call,
  type Communication,
  type RecordCallDispositionInput,
} from "@backoffice/domain";
import { toCall, toCommunication, type Row } from "../rows";
import type { ServiceContext } from "../runtime";
import { writeAudit } from "./audit";
import { recordEvent } from "./events";

export interface RecordCallDispositionResult {
  communication: Communication;
  call: Call;
  /** False when `providerEventId` was already processed; nothing was changed this call. */
  created: boolean;
}

/**
 * Record the outcome of an ended voice call, scoped to the caller's organization. Idempotent on
 * (organization_id, providerEventId): a replayed call-ended webhook returns the first result and
 * writes no second event, audit entry, or disposition update.
 */
export async function recordCallDisposition(
  ctx: ServiceContext,
  input: RecordCallDispositionInput,
): Promise<RecordCallDispositionResult> {
  await ctx.authorize("communication.write");
  const data = parseInput(recordCallDispositionInput, input);

  const { rows } = await ctx.tx.asService<Row>(
    `select c.* from public.communications c
       join public.calls on calls.communication_id = c.id
      where c.id = $1 and c.organization_id = $2 and c.channel = 'voice'`,
    [data.communicationId, ctx.organizationId],
  );
  const communicationRow = rows[0];
  if (!communicationRow) throw new NotFoundError("call", data.communicationId);

  const { event, created } = await recordEvent(ctx, {
    type: EVENT_TYPES.callDispositionRecorded,
    entityType: "communication",
    entityId: data.communicationId,
    idempotencyKey: `communication.disposition_recorded:${ctx.organizationId}:${data.providerEventId}`,
    payload: { disposition: data.disposition, duration_seconds: data.durationSeconds ?? null },
  });

  if (!created) {
    const { rows: callRows } = await ctx.tx.asService<Row>(
      `select * from public.calls where communication_id = $1`,
      [data.communicationId],
    );
    return {
      communication: toCommunication(communicationRow),
      call: toCall(callRows[0] as Row),
      created: false,
    };
  }

  const { rows: callRows } = await ctx.tx.asService<Row>(
    `update public.calls
        set disposition = $2, duration_seconds = coalesce($3, duration_seconds),
            recording_url = coalesce($4, recording_url)
      where communication_id = $1 returning *`,
    [data.communicationId, data.disposition, data.durationSeconds ?? null, data.recordingUrl ?? null],
  );
  const { rows: updatedCommRows } = await ctx.tx.asService<Row>(
    `update public.communications
        set status = 'completed', ended_at = coalesce($2, ended_at, now())
      where id = $1 returning *`,
    [data.communicationId, data.endedAt ?? null],
  );
  await writeAudit(ctx, {
    action: "communication.disposition_recorded",
    entityType: "communication",
    entityId: data.communicationId,
    sourceEventId: event.id,
    details: { disposition: data.disposition, duration_seconds: data.durationSeconds ?? null },
  });

  return {
    communication: toCommunication(updatedCommRows[0] as Row),
    call: toCall(callRows[0] as Row),
    created: true,
  };
}
