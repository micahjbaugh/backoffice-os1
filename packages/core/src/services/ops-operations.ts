// Ops console: operator visibility and remediation for dead-lettered webhook events (M2-T24).
// Same access model as ops cases (./ops.ts): internal staff only, and only for organizations that
// currently grant them access. Unrouted events (organization_id is null) belong to no tenant yet,
// so they are read through the service role, not through a grant.
//
// Retry is safe here because a dead event never finished processing and handlers are idempotent
// (see ./webhooks.ts); replaying it cannot duplicate anything it already did.

import { ConflictError, ForbiddenError, NotFoundError, type UUID } from "@backoffice/domain";
import type { Tx } from "../db/tx";
import { inTenant } from "../runtime";
import { writeAudit } from "./audit";
import { requireInternalStaff } from "./ops";
import { type Row } from "../rows";
import { toWebhookEvent, type WebhookEvent } from "./webhooks";

export interface OperatorWebhookEvent extends WebhookEvent {
  organizationName: string;
}

export interface StuckWebhookEvents {
  /** Dead-lettered events, scoped to organizations the operator currently has a grant for. */
  dead: OperatorWebhookEvent[];
  /** No tenant resolved yet; nothing to grant access to until a provider route exists. */
  unrouted: WebhookEvent[];
}

export async function listStuckWebhookEvents(tx: Tx): Promise<StuckWebhookEvents> {
  await requireInternalStaff(tx);
  const dead = await tx.asUser<Row>(
    `select w.*, o.name as organization_name
       from public.webhook_receipts w join public.organizations o on o.id = w.organization_id
      where w.status = 'dead' and public.has_operator_grant(w.organization_id)
      order by w.received_at`,
  );
  const unrouted = await tx.asService<Row>(
    `select * from public.webhook_receipts where status = 'unroutable' order by received_at`,
  );
  return {
    dead: dead.rows.map((r) => ({
      ...toWebhookEvent(r),
      organizationName: String(r.organization_name),
    })),
    unrouted: unrouted.rows.map(toWebhookEvent),
  };
}

async function loadGrantedDeadWebhookEvent(
  tx: Tx,
  id: UUID,
  action: string,
): Promise<WebhookEvent & { organizationId: UUID }> {
  const { rows } = await tx.asUser<Row>(
    `select * from public.webhook_receipts
      where id = $1 and organization_id is not null and public.has_operator_grant(organization_id)`,
    [id],
  );
  if (rows[0]) {
    const event = toWebhookEvent(rows[0]) as WebhookEvent & { organizationId: UUID };
    if (event.status !== "dead")
      throw new ConflictError("wrong_status", `Webhook event ${id} is ${event.status}, not dead`);
    return event;
  }
  const exists = await tx.asService<{ organization_id: UUID | null }>(
    `select organization_id from public.webhook_receipts where id = $1`,
    [id],
  );
  const orgId = exists.rows[0]?.organization_id;
  if (!orgId) throw new NotFoundError("dead webhook event", id);
  throw new ForbiddenError({
    action,
    reason: "no_active_grant",
    organizationId: orgId,
    entityType: "webhook_event",
    entityId: id,
  });
}

export async function retryDeadWebhookEvent(tx: Tx, id: UUID): Promise<WebhookEvent> {
  await requireInternalStaff(tx);
  const event = await loadGrantedDeadWebhookEvent(tx, id, "webhook_event.retry");
  const { rows } = await tx.asService<Row>(
    `update public.webhook_receipts
        set status = 'received', attempts = 0, next_attempt_at = null, locked_until = null,
            last_error = null
      where id = $1 and status = 'dead'
      returning *`,
    [id],
  );
  if (!rows[0]) throw new ConflictError("wrong_status", `Webhook event ${id} is no longer dead`);
  await writeAudit(inTenant(tx, event.organizationId), {
    action: "webhook_event.retried",
    entityType: "webhook_event",
    entityId: id,
    details: { provider: event.provider, event_type: event.eventType },
  });
  return toWebhookEvent(rows[0]);
}

export async function cancelDeadWebhookEvent(tx: Tx, id: UUID): Promise<WebhookEvent> {
  await requireInternalStaff(tx);
  const event = await loadGrantedDeadWebhookEvent(tx, id, "webhook_event.cancel");
  const { rows } = await tx.asService<Row>(
    `update public.webhook_receipts set status = 'ignored', processed_at = now()
      where id = $1 and status = 'dead'
      returning *`,
    [id],
  );
  if (!rows[0]) throw new ConflictError("wrong_status", `Webhook event ${id} is no longer dead`);
  await writeAudit(inTenant(tx, event.organizationId), {
    action: "webhook_event.cancelled",
    entityType: "webhook_event",
    entityId: id,
    details: { provider: event.provider, event_type: event.eventType },
  });
  return toWebhookEvent(rows[0]);
}
