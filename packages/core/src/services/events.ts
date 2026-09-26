import { actorUserId, type BusinessEvent, type UUID } from "@backoffice/domain";
import { toBusinessEvent, type Row } from "../rows";
import type { ServiceContext } from "../runtime";

export interface RecordEventInput {
  type: string;
  source?: string;
  sourceRef?: string;
  entityType?: string;
  entityId?: UUID;
  payload?: Record<string, unknown>;
  correlationId?: UUID;
  causationId?: UUID;
  idempotencyKey?: string;
}

export interface RecordedEvent {
  event: BusinessEvent;
  /** False when an event with the same idempotency key already existed (nothing new written). */
  created: boolean;
}

/**
 * Append a business event. Server-internal: this is never exposed as a client-callable action,
 * and callers must have authorized the underlying operation already.
 * Idempotent on (organization_id, idempotency_key).
 */
export async function recordEvent(
  ctx: ServiceContext,
  input: RecordEventInput,
): Promise<RecordedEvent> {
  const { rows } = await ctx.tx.asService<Row>(
    `insert into public.business_events
       (organization_id, type, source, source_ref, actor_type, actor_id, entity_type, entity_id,
        payload, correlation_id, causation_id, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing
     returning *`,
    [
      ctx.organizationId,
      input.type,
      input.source ?? "app",
      input.sourceRef ?? null,
      ctx.actor.type,
      actorUserId(ctx.actor),
      input.entityType ?? null,
      input.entityId ?? null,
      input.payload ?? {},
      input.correlationId ?? null,
      input.causationId ?? null,
      input.idempotencyKey ?? null,
    ],
  );
  if (rows[0]) return { event: toBusinessEvent(rows[0]), created: true };

  const existing = await ctx.tx.asService<Row>(
    `select * from public.business_events where organization_id = $1 and idempotency_key = $2`,
    [ctx.organizationId, input.idempotencyKey],
  );
  if (!existing.rows[0]) throw new Error("event idempotency conflict without existing row");
  return { event: toBusinessEvent(existing.rows[0]), created: false };
}

export async function listEvents(
  ctx: ServiceContext,
  filter: { entityType?: string; entityId?: UUID; limit?: number } = {},
): Promise<BusinessEvent[]> {
  await ctx.authorize("event.read");
  const { rows } = await ctx.scoped<Row>(
    `select * from public.business_events
      where organization_id = $1
        and ($2::text is null or entity_type = $2)
        and ($3::uuid is null or entity_id = $3)
      order by occurred_at desc
      limit $4`,
    [ctx.organizationId, filter.entityType ?? null, filter.entityId ?? null, filter.limit ?? 50],
  );
  return rows.map(toBusinessEvent);
}
