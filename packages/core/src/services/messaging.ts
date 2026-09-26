// SMS delivery status and outbound SMS requests (foundation repair, findings 5 and 6).

import { z } from "zod";
import { EVENT_TYPES, NotFoundError, parseInput, type UUID } from "@backoffice/domain";
import type { ServiceContext } from "../runtime";
import { writeAudit } from "./audit";
import { recordEvent } from "./events";
import { enqueueOutboundOperation, type OutboundOperation } from "./outbound";

export const SMS_SEND_OPERATION = "sms.send";

/**
 * Apply a provider delivery status to an outbound message. Statuses carry a lifecycle rank; an
 * update with a rank at or below the current one (a late or out-of-order callback) changes nothing.
 * Returns "not_found" when the message is not recorded yet (the callback beat the send result), so
 * the caller can retry later instead of dropping the update.
 */
export async function applyMessageDeliveryStatus(
  ctx: ServiceContext,
  input: { providerMessageId: string; status: string; rank: number; errorCode: string | null },
): Promise<"applied" | "stale" | "not_found"> {
  await ctx.authorize("communication.write");
  const { rows } = await ctx.tx.asService<{ id: string; applied: boolean }>(
    `with target as (
       select id, delivery_status_rank as old_rank from public.messages
        where organization_id = $1 and provider_message_id = $2
        for update)
     update public.messages m
        set delivery_status = case when target.old_rank < $4 then $3 else m.delivery_status end,
            delivery_error_code = case when target.old_rank < $4 then coalesce($5, m.delivery_error_code) else m.delivery_error_code end,
            delivery_status_rank = greatest(target.old_rank, $4)
       from target
      where m.id = target.id
      returning m.id, (target.old_rank < $4) as applied`,
    [ctx.organizationId, input.providerMessageId, input.status, input.rank, input.errorCode],
  );
  if (rows.length === 0) return "not_found";
  return rows[0]?.applied ? "applied" : "stale";
}

const requestSmsInput = z.object({
  fromNumber: z.string().trim().min(1).max(64),
  toNumber: z.string().trim().min(1).max(64),
  body: z.string().trim().min(1).max(1600),
  idempotencyKey: z.string().trim().min(8).max(200),
  entityType: z.string().max(64).optional(),
  entityId: z.uuid().optional(),
});

/**
 * Queue an outbound SMS. Authorization happens here (communication.write); the outbox worker sends
 * it. The from-number must be one of the organization's active SMS routes.
 */
export async function requestOutboundSms(
  ctx: ServiceContext,
  input: z.input<typeof requestSmsInput>,
): Promise<{ operation: OutboundOperation; created: boolean }> {
  await ctx.authorize("communication.write");
  const data = parseInput(requestSmsInput, input);
  const route = await ctx.tx.asService<{ provider: string }>(
    `select provider from public.provider_routes
      where organization_id = $1 and channel = 'sms' and address = $2 and active`,
    [ctx.organizationId, data.fromNumber],
  );
  const provider = route.rows[0]?.provider;
  if (!provider) throw new NotFoundError("sms route for", data.fromNumber);

  const result = await enqueueOutboundOperation(ctx, {
    operationType: SMS_SEND_OPERATION,
    idempotencyKey: data.idempotencyKey,
    provider,
    entityType: data.entityType,
    entityId: data.entityId as UUID | undefined,
    request: { fromNumber: data.fromNumber, toNumber: data.toNumber, body: data.body },
  });
  if (result.created) {
    const { event } = await recordEvent(ctx, {
      type: EVENT_TYPES.smsSendRequested,
      entityType: "outbound_operation",
      entityId: result.operation.id,
      idempotencyKey: `sms.send_requested:${result.operation.id}`,
      payload: { operation_id: result.operation.id, to_number: data.toNumber },
    });
    await writeAudit(ctx, {
      action: "sms.send_requested",
      entityType: "outbound_operation",
      entityId: result.operation.id,
      sourceEventId: event.id,
      details: { to_number: data.toNumber, entity_type: data.entityType ?? null },
    });
  }
  return result;
}
