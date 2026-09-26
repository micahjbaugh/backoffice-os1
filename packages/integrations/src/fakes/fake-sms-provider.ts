import type {
  ProviderSmsWebhookEvent,
  SendSmsRequest,
  SmsOperationResult,
  SmsProvider,
} from "../providers/sms-provider";

/**
 * In-memory SmsProvider for tests and local demos. Not a vendor SDK.
 * Idempotency keys are honored per organization so repeated sends with the
 * same key return the original result instead of sending twice.
 */
export class FakeSmsProvider implements SmsProvider {
  readonly webhookLog: ProviderSmsWebhookEvent[] = [];
  private readonly messagesByIdempotencyKey = new Map<string, SmsOperationResult>();
  private readonly sentBodies: SendSmsRequest[] = [];
  private messageCounter = 0;

  async sendSMS(request: SendSmsRequest): Promise<SmsOperationResult> {
    const key = `${request.organizationId}:${request.idempotencyKey}`;
    const existing = this.messagesByIdempotencyKey.get(key);
    if (existing) return existing;
    const result: SmsOperationResult = {
      providerMessageId: `fake-msg-${++this.messageCounter}`,
      status: "queued",
    };
    this.messagesByIdempotencyKey.set(key, result);
    this.sentBodies.push(request);
    return result;
  }

  async ingestWebhook(rawEvent: unknown): Promise<ProviderSmsWebhookEvent> {
    const event = rawEvent as Partial<ProviderSmsWebhookEvent>;
    const normalized: ProviderSmsWebhookEvent = {
      provider: "fake-sms",
      providerEventId: String(event.providerEventId),
      payload: event.payload ?? rawEvent,
    };
    this.webhookLog.push(normalized);
    return normalized;
  }

  get sentMessages(): readonly SendSmsRequest[] {
    return this.sentBodies;
  }
}
