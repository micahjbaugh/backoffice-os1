import type {
  CallOperationResult,
  InboundRoute,
  InboundRouteConfig,
  OutboundCallRequest,
  ProviderWebhookEvent,
  TransferCallRequest,
  VoiceProvider,
} from "../providers/voice-provider";
import { signWebhookBody, verifyWebhookSignature, type WebhookHeaders } from "../webhook-signing";

const WEBHOOK_SIGNATURE_HEADER = "x-fake-signature";

/**
 * In-memory VoiceProvider for tests and local demos. Not a vendor SDK.
 * Idempotency keys are honored per organization so repeated calls with the
 * same key return the original result instead of creating a new call.
 */
export class FakeVoiceProvider implements VoiceProvider {
  readonly routes: InboundRoute[] = [];
  readonly webhookLog: ProviderWebhookEvent[] = [];
  private readonly callsByIdempotencyKey = new Map<string, CallOperationResult>();
  private routeCounter = 0;
  private callCounter = 0;

  constructor(private readonly webhookSecret = "fake-voice-webhook-secret") {}

  /** Signs a raw body the way the real provider would; use this to build valid test requests. */
  signWebhook(rawBody: string): string {
    return signWebhookBody(this.webhookSecret, rawBody);
  }

  verifyWebhookSignature(rawBody: string, headers: WebhookHeaders): boolean {
    return verifyWebhookSignature(
      this.webhookSecret,
      rawBody,
      headers.get(WEBHOOK_SIGNATURE_HEADER),
    );
  }

  async createInboundRoute(config: InboundRouteConfig): Promise<InboundRoute> {
    const route: InboundRoute = {
      providerRouteId: `fake-route-${++this.routeCounter}`,
      phoneNumber: config.phoneNumber,
    };
    this.routes.push(route);
    return route;
  }

  async initiateOutboundCall(request: OutboundCallRequest): Promise<CallOperationResult> {
    const key = `${request.organizationId}:${request.idempotencyKey}`;
    const existing = this.callsByIdempotencyKey.get(key);
    if (existing) return existing;
    const result: CallOperationResult = {
      providerCallId: `fake-call-${++this.callCounter}`,
      status: "queued",
    };
    this.callsByIdempotencyKey.set(key, result);
    return result;
  }

  async transferCall(request: TransferCallRequest): Promise<CallOperationResult> {
    const key = `${request.organizationId}:${request.idempotencyKey}`;
    const existing = this.callsByIdempotencyKey.get(key);
    if (existing) return existing;
    const result: CallOperationResult = {
      providerCallId: request.providerCallId,
      status: "transferred",
    };
    this.callsByIdempotencyKey.set(key, result);
    return result;
  }

  async ingestWebhook(rawEvent: unknown): Promise<ProviderWebhookEvent> {
    const event = rawEvent as Partial<ProviderWebhookEvent>;
    const normalized: ProviderWebhookEvent = {
      provider: "fake-voice",
      providerEventId: String(event.providerEventId),
      payload: event.payload ?? rawEvent,
    };
    this.webhookLog.push(normalized);
    return normalized;
  }
}
