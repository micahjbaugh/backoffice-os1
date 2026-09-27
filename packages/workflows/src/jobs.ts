// One pass of background work. The web app exposes it at POST /api/internal/jobs (bearer secret);
// run it from a scheduler every minute or so (deployment decision: docs/PRODUCTION_HARDENING.md).
// Every step is safe to run concurrently and to re-run after a crash.

import type { Database } from "@backoffice/core";
import type { ProviderRuntime } from "@backoffice/integrations";
import {
  dispatchOutboundOperations,
  reconcileUnknownOperations,
  type DispatchSummary,
} from "./outbound-dispatcher";
import { purgeExpiredRetention, type RetentionPurgeSummary } from "./retention-purge";
import { processWebhookEvents, type ProcessSummary } from "./webhook-processor";

export interface JobsSummary {
  webhooks: ProcessSummary;
  outbound: DispatchSummary;
  reconciliation: { reconciled: number; escalated: number };
  retention: RetentionPurgeSummary;
}

export async function runBackgroundJobs(
  db: Database,
  runtime: ProviderRuntime,
): Promise<JobsSummary> {
  const webhooks = await processWebhookEvents(db);
  const outbound = await dispatchOutboundOperations(db, runtime);
  const reconciliation = await reconcileUnknownOperations(db, runtime);
  const retention = await purgeExpiredRetention(db);
  return { webhooks, outbound, reconciliation, retention };
}
