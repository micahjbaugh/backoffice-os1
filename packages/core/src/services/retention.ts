// Retention purge (M2-T25): webhook payload bodies and communication transcripts/summaries are
// kept only for each organization's configured window, then cleared while identity, disposition,
// participants and the append-only event/audit trail stay untouched forever.
//
// Both purges are pure SQL set operations scoped by each org's own retention window (joined from
// `organizations`), so one pass safely covers every tenant. Idempotent: a row already past its
// window and already cleared is excluded from candidates (`payload_purged_at is null` /
// `retention_status = 'active'`), so re-running finds nothing new to do.

import type { UUID } from "@backoffice/domain";
import type { Tx } from "../db/tx";

export interface RetentionPurgeBatch {
  organizationId: UUID;
  count: number;
}

/**
 * Clear payload bodies of webhook events that finished successfully (`processed`/`ignored`) more
 * than the organization's `webhook_payload_retention_days` ago. Events still needing work
 * (received, processing, failed, dead, unroutable) are never selected as candidates.
 */
export async function purgeExpiredWebhookPayloads(
  tx: Tx,
  limit = 500,
): Promise<RetentionPurgeBatch[]> {
  const { rows } = await tx.asService<{ organization_id: UUID; count: string }>(
    `with candidates as (
       select w.id, w.organization_id
         from public.webhook_receipts w
         join public.organizations o on o.id = w.organization_id
        where w.payload_purged_at is null
          and w.status in ('processed', 'ignored')
          and w.processed_at is not null
          and w.processed_at < now() - make_interval(days => o.webhook_payload_retention_days)
        limit $1
     ),
     purged as (
       update public.webhook_receipts w
          set payload = '{}'::jsonb, payload_purged_at = now()
         from candidates c
        where w.id = c.id
       returning w.organization_id
     )
     select organization_id, count(*) as count from purged group by organization_id`,
    [limit],
  );
  return rows.map((r) => ({ organizationId: String(r.organization_id), count: Number(r.count) }));
}

/**
 * Clear transcript/summary/structured extraction of communications that ended more than the
 * organization's `communication_retention_days` ago, moving them to `retention_status = 'deleted'`.
 * A communication still `in_progress` is never selected as a candidate.
 */
export async function purgeExpiredCommunications(
  tx: Tx,
  limit = 500,
): Promise<RetentionPurgeBatch[]> {
  const { rows } = await tx.asService<{ organization_id: UUID; count: string }>(
    `with candidates as (
       select c.id, c.organization_id
         from public.communications c
         join public.organizations o on o.id = c.organization_id
        where c.retention_status = 'active'
          and c.status in ('completed', 'failed', 'abandoned')
          and coalesce(c.ended_at, c.started_at)
              < now() - make_interval(days => o.communication_retention_days)
        limit $1
     ),
     purged as (
       update public.communications c
          set retention_status = 'deleted',
              summary = null,
              transcript = null,
              structured_extraction = '{}'::jsonb
         from candidates x
        where c.id = x.id
       returning c.organization_id
     )
     select organization_id, count(*) as count from purged group by organization_id`,
    [limit],
  );
  return rows.map((r) => ({ organizationId: String(r.organization_id), count: Number(r.count) }));
}
