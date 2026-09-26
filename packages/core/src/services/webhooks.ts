// Durable webhook event store (foundation repair, finding 5).
//
// Lifecycle:  received --claim--> processing --> processed | ignored
//                                   |  \--error--> failed --(backoff)--> processing ... --> dead
//             unroutable (no provider route: nothing to process until a route exists)
//
// * Identity: (provider, provider_event_id) where provider_event_id is the derived EVENT key, not the
//   call/message id. A provider retry of the same event is a duplicate (delivery_count++); a new
//   status for the same message is a new event.
// * Acceptance is durable before the HTTP response: the route only returns 2xx after this commit.
// * Processing is at-least-once: claims use FOR UPDATE SKIP LOCKED with a lock expiry, so a crashed
//   worker's event is picked up again. Handlers must be idempotent (they are keyed on the event).
// * Tenants come from provider_routes (the address the event was sent to), never from the payload.
// Server-internal only: every function runs as service; webhook_receipts has no client access.

import { createHash } from "node:crypto";
import type { UUID } from "@backoffice/domain";
import type { Database } from "../db/types";
import type { Tx } from "../db/tx";
import { iso, isoOrNull, type Row } from "../rows";

export type WebhookEventStatus =
  "received" | "processing" | "processed" | "failed" | "dead" | "ignored" | "unroutable";

export interface WebhookEvent {
  id: UUID;
  provider: string;
  eventKey: string;
  eventType: string | null;
  resourceId: string | null;
  deliveryId: string | null;
  organizationId: UUID | null;
  occurredAt: string | null;
  payload: Record<string, unknown>;
  payloadHash: string | null;
  status: WebhookEventStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  deliveryCount: number;
  receivedAt: string;
  processedAt: string | null;
}

export interface AcceptWebhookInput {
  provider: string;
  channel: "sms" | "voice";
  eventType: string;
  eventKey: string;
  resourceId: string;
  deliveryId: string | null;
  occurredAt: string | null;
  routingAddress: string | null;
  payload: Record<string, unknown>;
  rawBody: string;
}

export interface AcceptedWebhook {
  event: WebhookEvent;
  /** True when this event key was already stored (a retry); nothing new was written. */
  duplicate: boolean;
  /** A duplicate whose body differs from the first delivery: worth a look, never overwritten. */
  payloadMismatch: boolean;
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "string"
    ? (JSON.parse(v) as Record<string, unknown>)
    : ((v ?? {}) as Record<string, unknown>);
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);

export const toWebhookEvent = (r: Row): WebhookEvent => ({
  id: String(r.id),
  provider: String(r.provider),
  eventKey: String(r.provider_event_id),
  eventType: s(r.event_type),
  resourceId: s(r.resource_id),
  deliveryId: s(r.delivery_id),
  organizationId: s(r.organization_id),
  occurredAt: isoOrNull(r.occurred_at),
  payload: obj(r.payload),
  payloadHash: s(r.payload_hash),
  status: String(r.status) as WebhookEventStatus,
  attempts: Number(r.attempts),
  maxAttempts: Number(r.max_attempts),
  lastError: s(r.last_error),
  deliveryCount: Number(r.delivery_count),
  receivedAt: iso(r.received_at),
  processedAt: isoOrNull(r.processed_at),
});

export function payloadHash(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

/** Tenant for an inbound event, from the trusted route table. */
export async function resolveProviderRoute(
  tx: Tx,
  provider: string,
  address: string | null,
): Promise<UUID | null> {
  if (!address) return null;
  const { rows } = await tx.asService<{ organization_id: string }>(
    `select organization_id from public.provider_routes
      where provider = $1 and address = $2 and active`,
    [provider, address],
  );
  return rows[0]?.organization_id ?? null;
}

/** Durably accept an authenticated, validated webhook. Idempotent on the event key. */
export async function acceptWebhookEvent(
  tx: Tx,
  input: AcceptWebhookInput,
): Promise<AcceptedWebhook> {
  const organizationId = await resolveProviderRoute(tx, input.provider, input.routingAddress);
  const hash = payloadHash(input.rawBody);
  const { rows } = await tx.asService<Row>(
    `insert into public.webhook_receipts
       (provider, provider_event_id, organization_id, payload_hash, status, event_type,
        resource_id, delivery_id, occurred_at, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (provider, provider_event_id) do update set
       delivery_count = public.webhook_receipts.delivery_count + 1,
       last_delivery_at = now()
     returning *, (xmax = 0) as inserted`,
    [
      input.provider,
      input.eventKey,
      organizationId,
      hash,
      organizationId ? "received" : "unroutable",
      input.eventType,
      input.resourceId,
      input.deliveryId,
      input.occurredAt,
      // Keep the routing address and channel with the payload so unroutable events can be re-queued
      // once a route exists, and so processing never needs the raw request again.
      JSON.stringify({
        ...input.payload,
        routingAddress: input.routingAddress,
        channel: input.channel,
      }),
    ],
  );
  const row = rows[0] as Row;
  const event = toWebhookEvent(row);
  const duplicate = row.inserted !== true;
  return { event, duplicate, payloadMismatch: duplicate && event.payloadHash !== hash };
}

/**
 * Claim up to `limit` events ready to process: new, due for retry, or stuck in `processing` past
 * their lock (a crashed worker). Each claim increments `attempts`.
 */
export async function claimWebhookEvents(
  db: Database,
  opts: { limit?: number; lockSeconds?: number } = {},
): Promise<WebhookEvent[]> {
  return db.transaction(async (exec) => {
    const { rows } = await exec.query<Row>(
      `update public.webhook_receipts
          set status = 'processing', attempts = attempts + 1,
              locked_until = now() + make_interval(secs => $2)
        where id in (
          select id from public.webhook_receipts
           where (status in ('received', 'failed') and coalesce(next_attempt_at, '-infinity') <= now())
              or (status = 'processing' and locked_until < now())
           order by coalesce(occurred_at, received_at), received_at
           for update skip locked
           limit $1)
        returning *`,
      [opts.limit ?? 25, opts.lockSeconds ?? 120],
    );
    return rows
      .map(toWebhookEvent)
      .sort((a, b) => (a.occurredAt ?? a.receivedAt).localeCompare(b.occurredAt ?? b.receivedAt));
  });
}

export async function completeWebhookEvent(
  tx: Tx,
  id: UUID,
  outcome: { status: "processed" | "ignored"; note?: string },
): Promise<void> {
  await tx.asService(
    `update public.webhook_receipts
        set status = $2, processed_at = now(), locked_until = null, last_error = $3
      where id = $1 and status = 'processing'`,
    [id, outcome.status, outcome.note ?? null],
  );
}

/** Retry delay after the Nth failed attempt: 30s, 60s, 120s ... capped at 1 hour. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Record a processing failure. Returns the new status: `failed` (will retry after backoff) or
 * `dead` (attempts exhausted; the caller escalates to a person).
 */
export async function failWebhookEvent(
  tx: Tx,
  event: WebhookEvent,
  error: string,
): Promise<"failed" | "dead"> {
  const dead = event.attempts >= event.maxAttempts;
  await tx.asService(
    `update public.webhook_receipts
        set status = $2, locked_until = null, last_error = $3,
            next_attempt_at = case when $2 = 'failed' then now() + make_interval(secs => $4) else null end
      where id = $1`,
    [event.id, dead ? "dead" : "failed", error.slice(0, 2000), retryDelaySeconds(event.attempts)],
  );
  return dead ? "dead" : "failed";
}

export async function getWebhookEvent(
  tx: Tx,
  provider: string,
  eventKey: string,
): Promise<WebhookEvent | null> {
  const { rows } = await tx.asService<Row>(
    `select * from public.webhook_receipts where provider = $1 and provider_event_id = $2`,
    [provider, eventKey],
  );
  return rows[0] ? toWebhookEvent(rows[0]) : null;
}

/** Re-queue events that became routable after a provider route was added. */
export async function requeueUnroutableWebhookEvents(
  tx: Tx,
  provider: string,
  address: string,
): Promise<number> {
  const organizationId = await resolveProviderRoute(tx, provider, address);
  if (!organizationId) return 0;
  const result = await tx.asService(
    `update public.webhook_receipts
        set organization_id = $3, status = 'received', next_attempt_at = null
      where provider = $1 and status = 'unroutable' and payload->>'routingAddress' = $2`,
    [provider, address, organizationId],
  );
  return result.rowCount;
}
