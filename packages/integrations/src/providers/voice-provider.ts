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

/** One tool the assistant may call, in provider-neutral JSON-Schema function-calling form. */
export interface AssistantToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * The receptionist's configuration for one call (M2-T19), independent of any voice provider's wire
 * format (ARCHITECTURE.md §7-8: provider-independent interfaces). `tools` is empty for a safe
 * fallback turn (unknown number or missing tenant configuration).
 */
export interface AssistantTurn {
  systemPrompt: string;
  firstMessage: string;
  tools: AssistantToolDescriptor[];
}

/** See SmsProvider: durable idempotency lives in the outbox, not in adapters. */
export interface VoiceProvider extends InboundWebhookAdapter {
  createInboundRoute(config: InboundRouteConfig): Promise<InboundRoute>;
  initiateOutboundCall(request: OutboundCallRequest): Promise<CallOperationResult>;
  transferCall(request: TransferCallRequest): Promise<CallOperationResult>;
  getCall(providerCallId: string): Promise<CallStatusSnapshot>;
  /** Build the provider's synchronous reply to an assistant-request-style webhook. */
  buildAssistantResponse(turn: AssistantTurn): Record<string, unknown>;
}
