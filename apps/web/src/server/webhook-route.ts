import "server-only";

import { NextResponse, after } from "next/server";
import { acceptWebhookEvent, runAs } from "@backoffice/core";
import {
  ProviderConfigError,
  WebhookPayloadError,
  type InboundWebhookAdapter,
  type ParsedWebhookEvent,
  type WebhookRequest,
} from "@backoffice/integrations";
import { processWebhookEvents } from "@backoffice/workflows";
import { db } from "./db";

/** Largest body we accept (Vapi end-of-call reports with transcripts can be large). */
export const MAX_WEBHOOK_BYTES = 1_000_000;

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status });

/**
 * Shared inbound webhook flow (foundation repair, findings 3–5):
 *
 *   1. adapter available?          no  -> 503 (misconfigured deployments fail closed)
 *   2. body within size limit?      no  -> 413
 *   3. signature over the ORIGINAL request valid?   no -> 401
 *   4. parse the provider's real wire format and validate   malformed -> 400
 *   5. durably accept (tenant from provider_routes, never from the payload)   DB error -> 500 (provider retries)
 *   6. an event the provider waits on synchronously (e.g. Vapi assistant-request) gets its answer here,
 *      within the request; everything else is acknowledged and processed in the background
 */
export async function handleProviderWebhook(
  selectAdapter: () => InboundWebhookAdapter,
  request: Request,
  options: {
    processInBackground?: boolean;
    /** Returns the synchronous reply for a `requiresResponse` event, or null to use the default ack. */
    answerSynchronousEvent?: (event: ParsedWebhookEvent) => Promise<Record<string, unknown> | null>;
  } = {},
): Promise<Response> {
  let adapter: InboundWebhookAdapter;
  try {
    adapter = selectAdapter();
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      console.error(`webhook provider unavailable: ${error.message}`);
      return json(503, { error: "provider not configured" });
    }
    throw error;
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_WEBHOOK_BYTES)
    return json(413, { error: "payload too large" });

  const req: WebhookRequest = { rawBody, headers: request.headers, url: request.url };
  if (!adapter.verifyWebhookRequest(req)) {
    console.warn(`${adapter.provider} webhook rejected: invalid signature`);
    return json(401, { error: "invalid signature" });
  }

  let parsed;
  try {
    parsed = adapter.parseWebhookRequest(req);
  } catch (error) {
    if (error instanceof WebhookPayloadError) {
      console.warn(`${adapter.provider} webhook rejected: ${error.message}`);
      return json(400, { error: "invalid payload" });
    }
    throw error;
  }

  let accepted;
  try {
    accepted = await runAs(
      db(),
      { type: "integration", name: `${parsed.provider}-webhook` },
      (tx) => acceptWebhookEvent(tx, { ...parsed, rawBody }),
    );
  } catch (error) {
    console.error(`${parsed.provider} webhook could not be stored`, error);
    return json(500, { error: "temporarily unavailable" });
  }
  if (accepted.payloadMismatch) {
    console.warn(
      `${parsed.provider} event ${accepted.event.id} redelivered with a different body; kept the first`,
    );
  }

  if (parsed.requiresResponse && options.answerSynchronousEvent) {
    const answer = await options.answerSynchronousEvent(parsed);
    if (answer) return json(200, answer);
  }

  if (options.processInBackground ?? true) {
    after(async () => {
      try {
        await processWebhookEvents(db(), { limit: 10 });
      } catch (error) {
        console.error("background webhook processing failed (jobs endpoint will retry)", error);
      }
    });
  }

  // Twilio expects TwiML from messaging webhooks; an empty <Response/> means "no auto-reply".
  if (adapter.provider === "twilio") {
    return new NextResponse("<Response/>", {
      status: 200,
      headers: { "content-type": "text/xml" },
    });
  }
  return json(200, { received: true, duplicate: accepted.duplicate });
}
