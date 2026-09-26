// Webhook receipt tracking (M2-T06). This runs before any tenant is resolved from the payload, so
// it always executes as service and is never exposed as a client-callable action.

import { NotFoundError, type UUID } from "@backoffice/domain";
import type { Tx } from "../db/tx";
import { iso, isoOrNull, type Row } from "../rows";

export interface WebhookReceipt {
  id: UUID;
  provider: string;
  providerEventId: string;
  organizationId: UUID | null;
  payloadHash: string | null;
  receivedAt: string;
  processedAt: string | null;
  status: string;
}

export interface RecordWebhookReceiptInput {
  provider: string;
  providerEventId: string;
  organizationId?: UUID;
  payloadHash?: string;
}

export interface RecordedWebhookReceipt {
  receipt: WebhookReceipt;
  /** False when a receipt for this (provider, provider_event_id) already existed. */
  duplicate: boolean;
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new TypeError(`expected string, got ${typeof value}`);
  return value;
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : str(value);
}

const toWebhookReceipt = (r: Row): WebhookReceipt => ({
  id: str(r.id),
  provider: str(r.provider),
  providerEventId: str(r.provider_event_id),
  organizationId: strOrNull(r.organization_id),
  payloadHash: strOrNull(r.payload_hash),
  receivedAt: iso(r.received_at),
  processedAt: isoOrNull(r.processed_at),
  status: str(r.status),
});

/**
 * Idempotent insert keyed on (provider, provider_event_id). A duplicate delivery returns the
 * existing row instead of writing a second one, so retried/replayed provider webhooks never
 * double-process.
 */
export async function recordWebhookReceipt(
  tx: Tx,
  input: RecordWebhookReceiptInput,
): Promise<RecordedWebhookReceipt> {
  const { rows } = await tx.asService<Row>(
    `insert into public.webhook_receipts (provider, provider_event_id, organization_id, payload_hash)
     values ($1, $2, $3, $4)
     on conflict (provider, provider_event_id) do nothing
     returning *`,
    [
      input.provider,
      input.providerEventId,
      input.organizationId ?? null,
      input.payloadHash ?? null,
    ],
  );
  if (rows[0]) return { receipt: toWebhookReceipt(rows[0]), duplicate: false };

  const existing = await tx.asService<Row>(
    `select * from public.webhook_receipts where provider = $1 and provider_event_id = $2`,
    [input.provider, input.providerEventId],
  );
  if (!existing.rows[0]) {
    throw new Error("webhook receipt idempotency conflict without existing row");
  }
  return { receipt: toWebhookReceipt(existing.rows[0]), duplicate: true };
}

export async function getWebhookReceipt(
  tx: Tx,
  provider: string,
  providerEventId: string,
): Promise<WebhookReceipt | null> {
  const { rows } = await tx.asService<Row>(
    `select * from public.webhook_receipts where provider = $1 and provider_event_id = $2`,
    [provider, providerEventId],
  );
  return rows[0] ? toWebhookReceipt(rows[0]) : null;
}

/** Advance processing status; stamps `processed_at` once the receipt leaves `received`. */
export async function updateWebhookReceiptStatus(
  tx: Tx,
  id: UUID,
  status: string,
): Promise<WebhookReceipt> {
  const { rows } = await tx.asService<Row>(
    `update public.webhook_receipts
        set status = $2,
            processed_at = case when $2 = 'received' then processed_at else now() end
      where id = $1
      returning *`,
    [id, status],
  );
  if (!rows[0]) throw new NotFoundError("webhook_receipt", id);
  return toWebhookReceipt(rows[0]);
}
