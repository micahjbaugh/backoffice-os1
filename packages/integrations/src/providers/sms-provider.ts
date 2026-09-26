import type { WebhookHeaders } from "../webhook-signing";

export interface SendSmsRequest {
  organizationId: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  idempotencyKey: string;
}
export interface SmsOperationResult {
  providerMessageId: string;
  status: "queued" | "sent" | "delivered" | "failed";
}
export interface ProviderSmsWebhookEvent {
  provider: string;
  providerEventId: string;
  payload: unknown;
}
export interface SmsProvider {
  sendSMS(request: SendSmsRequest): Promise<SmsOperationResult>;
  /** Verify the provider's signature over the raw request body before the payload is trusted. */
  verifyWebhookSignature(rawBody: string, headers: WebhookHeaders): boolean;
  ingestWebhook(rawEvent: unknown): Promise<ProviderSmsWebhookEvent>;
}
