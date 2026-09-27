// Inbound webhook contract shared by every provider adapter.
//
// Flow (apps/web/src/server/webhook-route.ts): verify the request exactly as the provider signed it
// -> parse the provider's real wire format -> validate -> derive identities -> durably accept.
// Adapters never resolve tenants and never trust a tenant id carried in a payload; they only report
// the address the event was sent to (`routingAddress`), which the server maps through provider_routes.

import type { WebhookHeaders } from "./webhook-signing";

export interface WebhookRequest {
  /** The body exactly as received (signatures are computed over these bytes). */
  rawBody: string;
  headers: WebhookHeaders;
  /** The URL the request arrived on (path and query are used; host may be an internal one). */
  url: string;
}

export interface ParsedWebhookEvent {
  provider: string;
  channel: "sms" | "voice";
  /** Normalized type, e.g. "sms.inbound", "sms.status", "call.status", "call.ended". */
  eventType: string;
  /**
   * Identity of this logical event. Distinct updates about the same message/call get distinct keys
   * (e.g. "SM…:sent" vs "SM…:delivered"); a provider retry of the same update gets the same key.
   */
  eventKey: string;
  /** The message/call the event is about. */
  resourceId: string;
  /** Provider's per-delivery retry token when it has one (Twilio: I-Twilio-Idempotency-Token). */
  deliveryId: string | null;
  /** Provider timestamp for the event, when supplied. */
  occurredAt: string | null;
  /** Our number / provider resource the event was addressed to; used for tenant resolution. */
  routingAddress: string | null;
  /** True when the provider waits for a synchronous answer (e.g. Vapi assistant-request). */
  requiresResponse: boolean;
  /** Validated, normalized fields needed to process (and later re-process) the event. */
  payload: Record<string, unknown>;
  /** Present only for a synchronous tool-calls-style webhook (e.g. Vapi's "tool-calls" message). */
  toolCalls?: readonly { id: string; name: string; arguments: unknown }[];
}

/** A well-authenticated request whose body is malformed or not what the provider sends: HTTP 400. */
export class WebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookPayloadError";
  }
}

export interface InboundWebhookAdapter {
  readonly provider: string;
  readonly channel: "sms" | "voice";
  /** Authenticate the request as the provider sent it. Must not throw; false means reject (401). */
  verifyWebhookRequest(request: WebhookRequest): boolean;
  /** Parse and validate a verified request. Throws WebhookPayloadError for malformed input. */
  parseWebhookRequest(request: WebhookRequest): ParsedWebhookEvent;
}

export function contentTypeOf(headers: WebhookHeaders): string {
  return (headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}
