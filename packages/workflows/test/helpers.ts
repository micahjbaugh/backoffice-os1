// Test harness for the M2 communication pipeline: real adapters, realistic provider payloads, a real
// Postgres (PGlite) with every migration, and the same accept/process code the web app uses.

import { acceptWebhookEvent, runAs, type AcceptedWebhook } from "@backoffice/core";
import type { Actor } from "@backoffice/domain";
import {
  TwilioSmsProvider,
  VapiVoiceProvider,
  WebhookPayloadError,
  type InboundWebhookAdapter,
  type WebhookRequest,
} from "@backoffice/integrations";
import { count } from "../../core/test/helpers/db";
import { createWorld, type World } from "../../core/test/helpers/fixtures";
import {
  BUSINESS_NUMBER,
  CUSTOMER_NUMBER,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WEBHOOK_URL,
  vapiRequest,
  VAPI_WEBHOOK_SECRET,
} from "../../integrations/test/fixtures/providers";
import {
  executeReceptionistToolCalls,
  resolveAssistantTurn,
  resolveTransferDestination,
} from "../src";

export * from "../../integrations/test/fixtures/providers";
export { count, createWorld, type World };

export const ORG_B_NUMBER = "+15125550999";

export const twilio = new TwilioSmsProvider({
  accountSid: TWILIO_ACCOUNT_SID,
  authToken: TWILIO_AUTH_TOKEN,
  webhookUrl: TWILIO_WEBHOOK_URL,
});
export const vapi = new VapiVoiceProvider({
  apiKey: "vapi-api-key-for-tests-000001",
  webhookSecret: VAPI_WEBHOOK_SECRET,
});

const WEBHOOK_ACTOR: Actor = { type: "integration", name: "webhook-test" };

/** Same steps as apps/web/src/server/webhook-route.ts: verify -> parse -> durable accept. */
export async function deliver(
  w: World,
  adapter: InboundWebhookAdapter,
  request: { rawBody: string; headers: Headers; url: string },
): Promise<AcceptedWebhook> {
  const req: WebhookRequest = request;
  if (!adapter.verifyWebhookRequest(req)) throw new Error("signature rejected");
  const parsed = adapter.parseWebhookRequest(req);
  if (!parsed) throw new WebhookPayloadError("unparsed");
  return runAs(w.db, WEBHOOK_ACTOR, (tx) =>
    acceptWebhookEvent(tx, { ...parsed, rawBody: req.rawBody }),
  );
}

/**
 * Same flow as apps/web/src/app/api/webhooks/voice/route.ts (+ webhook-route.ts): verify -> parse ->
 * durable accept -> for a synchronous Vapi event, answer it with the same runtime functions the real
 * route calls, from the original parsed event (never re-read from storage, matching production).
 */
export async function deliverVoiceEvent(
  w: World,
  message: Record<string, unknown>,
): Promise<{ accepted: AcceptedWebhook; answer: Record<string, unknown> | null }> {
  const req: WebhookRequest = vapiRequest(message);
  if (!vapi.verifyWebhookRequest(req)) throw new Error("signature rejected");
  const parsed = vapi.parseWebhookRequest(req);
  if (!parsed) throw new WebhookPayloadError("unparsed");
  const accepted = await runAs(w.db, WEBHOOK_ACTOR, (tx) =>
    acceptWebhookEvent(tx, { ...parsed, rawBody: req.rawBody }),
  );

  let answer: Record<string, unknown> | null = null;
  if (parsed.requiresResponse) {
    const customerNumber = (parsed.payload.customerNumber as string | null) ?? null;
    const businessNumber = (parsed.payload.phoneNumber as string | null) ?? null;
    if (parsed.eventType === "call.assistant_request") {
      const turn = await resolveAssistantTurn(w.db, {
        provider: parsed.provider,
        routingAddress: parsed.routingAddress,
      });
      answer = vapi.buildAssistantResponse(turn);
    } else if (parsed.eventType === "call.tool_calls") {
      const results = await executeReceptionistToolCalls(w.db, {
        provider: parsed.provider,
        routingAddress: parsed.routingAddress,
        callId: parsed.resourceId,
        customerNumber,
        businessNumber,
        toolCalls: parsed.toolCalls ?? [],
      });
      answer = vapi.buildToolCallResponse(results);
    } else if (parsed.eventType === "call.transfer_destination_request") {
      const destination = await resolveTransferDestination(w.db, {
        provider: parsed.provider,
        routingAddress: parsed.routingAddress,
        callId: parsed.resourceId,
        customerNumber,
        businessNumber,
      });
      answer = vapi.buildTransferDestinationResponse(destination);
    }
  }
  return { accepted, answer };
}

/** Org A owns BUSINESS_NUMBER on both providers; org B owns ORG_B_NUMBER. The caller is an org A customer. */
export async function setupRoutes(w: World): Promise<{ customerId: string }> {
  await w.pg.query(
    `insert into public.provider_routes (organization_id, provider, channel, address) values
       ($1, 'twilio', 'sms', $2), ($1, 'vapi', 'voice', $2),
       ($3, 'twilio', 'sms', $4), ($3, 'vapi', 'voice', $4)`,
    [w.orgA.id, BUSINESS_NUMBER, w.orgB.id, ORG_B_NUMBER],
  );
  const { rows } = await w.pg.query<{ id: string }>(
    `insert into public.customers (organization_id, display_name, phone) values ($1, 'Wilson Farms', $2) returning id`,
    [w.orgA.id, CUSTOMER_NUMBER],
  );
  return { customerId: (rows[0] as { id: string }).id };
}

/** Make every failed/pending item due now (skip real backoff waits). */
export async function makeEverythingDue(w: World): Promise<void> {
  await w.pg.query(
    `update public.webhook_receipts set next_attempt_at = now() - interval '1 second' where status = 'failed'`,
  );
  await w.pg.query(
    `update public.outbound_operations set next_attempt_at = now() - interval '1 second' where status = 'pending'`,
  );
}

export const eventStatus = async (w: World, provider: string, key: string) =>
  (
    await w.pg.query<{ status: string; delivery_count: number; attempts: number }>(
      `select status, delivery_count, attempts from public.webhook_receipts where provider = $1 and provider_event_id = $2`,
      [provider, key],
    )
  ).rows[0];
