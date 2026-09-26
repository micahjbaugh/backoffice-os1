import type { WebhookHeaders } from "../webhook-signing";

export interface InboundRouteConfig {
  organizationId: string;
  phoneNumber: string;
  webhookUrl: string;
}
export interface InboundRoute {
  providerRouteId: string;
  phoneNumber: string;
}
export interface OutboundCallRequest {
  organizationId: string;
  fromNumber: string;
  toNumber: string;
  idempotencyKey: string;
}
export interface TransferCallRequest {
  organizationId: string;
  providerCallId: string;
  toNumber: string;
  idempotencyKey: string;
}
export interface CallOperationResult {
  providerCallId: string;
  status: "queued" | "in_progress" | "transferred" | "failed";
}
export interface ProviderWebhookEvent {
  provider: string;
  providerEventId: string;
  payload: unknown;
}
export interface VoiceProvider {
  createInboundRoute(config: InboundRouteConfig): Promise<InboundRoute>;
  initiateOutboundCall(request: OutboundCallRequest): Promise<CallOperationResult>;
  transferCall(request: TransferCallRequest): Promise<CallOperationResult>;
  /** Verify the provider's signature over the raw request body before the payload is trusted. */
  verifyWebhookSignature(rawBody: string, headers: WebhookHeaders): boolean;
  ingestWebhook(rawEvent: unknown): Promise<ProviderWebhookEvent>;
}
