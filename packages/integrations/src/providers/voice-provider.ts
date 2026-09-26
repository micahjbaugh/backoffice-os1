import type { InboundWebhookAdapter } from "../webhooks";

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
  /** Outbox operation id (see SendSmsRequest.operationId). */
  operationId: string;
}

export interface TransferCallRequest {
  organizationId: string;
  providerCallId: string;
  toNumber: string;
  operationId: string;
}

export interface CallOperationResult {
  providerCallId: string;
  status: "queued" | "in_progress" | "transferred" | "failed";
}

/** What the provider currently reports about a call; used to reconcile ambiguous operations. */
export interface CallStatusSnapshot {
  providerCallId: string;
  status: string;
  endedReason: string | null;
}

/** See SmsProvider: durable idempotency lives in the outbox, not in adapters. */
export interface VoiceProvider extends InboundWebhookAdapter {
  createInboundRoute(config: InboundRouteConfig): Promise<InboundRoute>;
  initiateOutboundCall(request: OutboundCallRequest): Promise<CallOperationResult>;
  transferCall(request: TransferCallRequest): Promise<CallOperationResult>;
  getCall(providerCallId: string): Promise<CallStatusSnapshot>;
}
