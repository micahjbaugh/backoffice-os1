// Scheduled retention purge (M2-T25): runs the two independent per-organization purges in
// packages/core/src/services/retention.ts and records an event + audit entry per organization
// touched, so a cleared payload or transcript is itself an auditable action (CLAUDE.md rule 8).
// Safe to run repeatedly/concurrently: the underlying purge queries are idempotent.

import {
  inTenant,
  purgeExpiredCommunications,
  purgeExpiredWebhookPayloads,
  recordEvent,
  runAs,
  writeAudit,
  type Database,
  type RetentionPurgeBatch,
} from "@backoffice/core";
import { EVENT_TYPES, type Actor } from "@backoffice/domain";

export const RETENTION_WORKER: Actor = { type: "system", name: "retention-worker" };

export interface RetentionPurgeSummary {
  webhookPayloadsPurged: number;
  communicationsPurged: number;
}

async function auditBatches(
  db: Database,
  batches: RetentionPurgeBatch[],
  eventType: string,
  action: string,
  entityType: string,
): Promise<void> {
  for (const batch of batches) {
    if (batch.count === 0) continue;
    await runAs(db, RETENTION_WORKER, async (tx) => {
      const ctx = inTenant(tx, batch.organizationId);
      const { event } = await recordEvent(ctx, {
        type: eventType,
        entityType,
        payload: { count: batch.count },
      });
      await writeAudit(ctx, {
        action,
        entityType,
        sourceEventId: event.id,
        details: { count: batch.count },
      });
    });
  }
}

/** One purge pass across every organization. Call on a schedule alongside the other background jobs. */
export async function purgeExpiredRetention(
  db: Database,
  opts: { limit?: number } = {},
): Promise<RetentionPurgeSummary> {
  const limit = opts.limit ?? 500;

  const webhookBatches = await runAs(db, RETENTION_WORKER, (tx) =>
    purgeExpiredWebhookPayloads(tx, limit),
  );
  await auditBatches(
    db,
    webhookBatches,
    EVENT_TYPES.webhookPayloadsPurged,
    "retention.webhook_payloads_purged",
    "webhook_receipt",
  );

  const communicationBatches = await runAs(db, RETENTION_WORKER, (tx) =>
    purgeExpiredCommunications(tx, limit),
  );
  await auditBatches(
    db,
    communicationBatches,
    EVENT_TYPES.communicationsPurged,
    "retention.communications_purged",
    "communication",
  );

  return {
    webhookPayloadsPurged: webhookBatches.reduce((sum, b) => sum + b.count, 0),
    communicationsPurged: communicationBatches.reduce((sum, b) => sum + b.count, 0),
  };
}
