import type { InboundWebhookAdapter } from "../webhooks";

export interface SendSmsRequest {
  organizationId: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  /**
   * The outbox operation id. Adapters pass it to the provider where supported (Twilio: on the
   * status-callback URL) so later provider events can reconcile an ambiguous send.
   */
  operationId: string;
}

export interface SmsOperationResult {
  providerMessageId: string;
  status: "queued" | "sent" | "delivered" | "failed";
}

/**
 * Durable idempotency is NOT the adapter's job: the outbox (outbound_operations) records intent
 * and outcome in the database. Adapters make one provider request per call and report failures as
 * ProviderRequestError ("rejected" vs "ambiguous") so the outbox can decide what is safe.
 */
export interface SmsProvider extends InboundWebhookAdapter {
  sendSMS(request: SendSmsRequest): Promise<SmsOperationResult>;
}
