// Turns durably-accepted webhook events into Business Brain records (foundation repair, finding 3).
//
// Each event is handled in ONE transaction together with marking it processed, so a crash between
// "records written" and "event marked done" is impossible: either both commit or the event is
// retried. Handlers are idempotent (communications upsert on the provider conversation, disposition
// keyed on the event, delivery status monotonic), so at-least-once processing is safe.
// Tenants come from the event's organization_id (resolved from provider_routes at acceptance).

import {
  applyMessageDeliveryStatus,
  claimWebhookEvents,
  completeWebhookEvent,
  createOpsCase,
  failWebhookEvent,
  inTenant,
  matchCallerByPhone,
  recordCall,
  recordCallDisposition,
  recordEvent,
  recordMessage,
  runAs,
  type Database,
  type ServiceContext,
  type WebhookEvent,
} from "@backoffice/core";
import { EVENT_TYPES, type Actor } from "@backoffice/domain";
import { reconcileSmsFromStatusCallback } from "./outbound-dispatcher";

export const WEBHOOK_PROCESSOR: Actor = { type: "system", name: "webhook-processor" };

/** A handler's verdict. `retry` means "not yet" (e.g. a callback that beat its message record). */
export type HandlerResult =
  { status: "processed" | "ignored"; note?: string } | { status: "retry"; reason: string };

export type WebhookHandler = (ctx: ServiceContext, event: WebhookEvent) => Promise<HandlerResult>;

class RetryLater extends Error {}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

async function callerParticipant(ctx: ServiceContext, phone: string | undefined) {
  if (!phone) return [];
  const match = await matchCallerByPhone(ctx, phone);
  if (match.status === "matched") {
    return [
      match.entityType === "customer"
        ? { role: "customer" as const, customerId: match.entityId, phone }
        : { role: "employee" as const, employeeId: match.entityId, phone },
    ];
  }
  // No match or ambiguous (the matcher opened an ops case for ambiguity): keep the raw number.
  return [{ role: "unknown" as const, phone }];
}

const handleInboundSms: WebhookHandler = async (ctx, event) => {
  const p = event.payload;
  await recordMessage(ctx, {
    direction: "inbound",
    provider: event.provider,
    providerConversationId: event.resourceId ?? String(p.messageSid),
    status: "completed",
    startedAt: event.occurredAt ?? event.receivedAt,
    providerMessageId: str(p.messageSid),
    fromAddress: str(p.from),
    toAddress: str(p.to),
    body: typeof p.body === "string" ? p.body : undefined,
    mediaUrls: Array.isArray(p.mediaUrls) ? (p.mediaUrls as string[]) : [],
    participants: await callerParticipant(ctx, str(p.from)),
  });
  return { status: "processed" };
};

const handleSmsStatus: WebhookHandler = async (ctx, event) => {
  const p = event.payload;
  const messageSid = str(p.messageSid) ?? event.resourceId ?? "";
  // A status callback proves the provider accepted the send: settle an ambiguous outbound op first,
  // which also records the outbound message if the worker never got the provider's response.
  const operationId = str(p.operationId);
  if (operationId) await reconcileSmsFromStatusCallback(ctx, operationId, messageSid);

  const applied = await applyMessageDeliveryStatus(ctx, {
    providerMessageId: messageSid,
    status: String(p.status),
    rank: num(p.statusRank) ?? 0,
    errorCode: str(p.errorCode) ?? null,
  });
  if (applied === "not_found")
    return { status: "retry", reason: `message ${messageSid} not recorded yet` };
  return {
    status: "processed",
    note: applied === "stale" ? "older than current status" : undefined,
  };
};

/** Vapi call status -> communication status (only terminal states change it; see upsertEnvelope). */
function communicationStatus(callStatus: string | undefined): "in_progress" | "completed" {
  return callStatus === "ended" ? "completed" : "in_progress";
}

const handleCallStatus: WebhookHandler = async (ctx, event) => {
  const p = event.payload;
  await recordCall(ctx, {
    direction: "inbound",
    provider: event.provider,
    providerConversationId: event.resourceId ?? String(p.callId),
    status: communicationStatus(str(p.status)),
    startedAt: event.occurredAt ?? undefined,
    providerCallId: event.resourceId ?? undefined,
    fromNumber: str(p.customerNumber),
    toNumber: str(p.phoneNumber),
    participants: await callerParticipant(ctx, str(p.customerNumber)),
  });
  return { status: "processed" };
};

const handleCallEnded: WebhookHandler = async (ctx, event) => {
  const p = event.payload;
  const { communication } = await recordCall(ctx, {
    direction: "inbound",
    provider: event.provider,
    providerConversationId: event.resourceId ?? String(p.callId),
    status: "completed",
    providerCallId: event.resourceId ?? undefined,
    fromNumber: str(p.customerNumber),
    toNumber: str(p.phoneNumber),
    startedAt: str(p.startedAt),
    endedAt: str(p.endedAt),
    summary: str(p.summary),
    transcript: str(p.transcript),
    durationSeconds:
      num(p.durationSeconds) === undefined
        ? undefined
        : Math.round(num(p.durationSeconds) as number),
    recordingUrl: str(p.recordingUrl),
  });
  await recordCallDisposition(ctx, {
    communicationId: communication.id,
    disposition: str(p.endedReason) ?? "ended",
    providerEventId: event.eventKey,
    endedAt: str(p.endedAt),
    durationSeconds:
      num(p.durationSeconds) === undefined
        ? undefined
        : Math.round(num(p.durationSeconds) as number),
    recordingUrl: str(p.recordingUrl),
  });
  return { status: "processed" };
};

/**
 * assistant-request, tool-calls and transfer-destination-request are already answered
 * synchronously, in the webhook route, before this event is ever claimed (M2-T19/T20/T21:
 * apps/web/src/app/api/webhooks/voice/route.ts). This handler only settles the durably-stored
 * receipt so it is not retried.
 */
const answeredSynchronously: WebhookHandler = async () => ({ status: "processed" });

export const DEFAULT_WEBHOOK_HANDLERS: Readonly<Record<string, WebhookHandler>> = {
  "sms.inbound": handleInboundSms,
  "sms.status": handleSmsStatus,
  "call.status": handleCallStatus,
  "call.ended": handleCallEnded,
  "call.assistant_request": answeredSynchronously,
  "call.tool_calls": answeredSynchronously,
  "call.transfer_destination_request": answeredSynchronously,
};

export interface ProcessSummary {
  claimed: number;
  processed: number;
  ignored: number;
  retrying: number;
  dead: number;
}

/** Process one batch of due webhook events. Safe to run concurrently from several workers. */
export async function processWebhookEvents(
  db: Database,
  opts: { limit?: number; handlers?: Readonly<Record<string, WebhookHandler>> } = {},
): Promise<ProcessSummary> {
  const handlers = opts.handlers ?? DEFAULT_WEBHOOK_HANDLERS;
  const events = await claimWebhookEvents(db, { limit: opts.limit ?? 25 });
  const summary: ProcessSummary = {
    claimed: events.length,
    processed: 0,
    ignored: 0,
    retrying: 0,
    dead: 0,
  };

  for (const event of events) {
    try {
      const status = await runAs(db, WEBHOOK_PROCESSOR, async (tx) => {
        if (!event.organizationId) throw new Error("event has no organization");
        const handler = event.eventType ? handlers[event.eventType] : undefined;
        const result: HandlerResult = handler
          ? await handler(inTenant(tx, event.organizationId), event)
          : { status: "ignored", note: `no handler for ${event.eventType ?? "unknown"} events` };
        if (result.status === "retry") throw new RetryLater(result.reason);
        await completeWebhookEvent(tx, event.id, result);
        return result.status;
      });
      summary[status] += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = await runAs(db, WEBHOOK_PROCESSOR, async (tx) => {
        const next = await failWebhookEvent(tx, event, message);
        if (next === "dead" && event.organizationId) {
          const ctx = inTenant(tx, event.organizationId);
          await createOpsCase(ctx, {
            title: `Webhook ${event.eventType ?? event.provider} could not be processed`,
            reasonCode: "integration_failure",
            priority: "high",
            evidence: {
              webhook_event_id: event.id,
              provider: event.provider,
              event_key: event.eventKey,
              attempts: event.attempts,
              error: message.slice(0, 500),
            },
          });
          await recordEvent(ctx, {
            type: EVENT_TYPES.webhookDeadLettered,
            entityType: "webhook_event",
            entityId: event.id,
            idempotencyKey: `webhook.dead_lettered:${event.id}`,
            payload: {
              provider: event.provider,
              event_type: event.eventType,
              attempts: event.attempts,
            },
          });
        }
        return next;
      });
      if (outcome === "dead") summary.dead += 1;
      else summary.retrying += 1;
    }
  }
  return summary;
}
