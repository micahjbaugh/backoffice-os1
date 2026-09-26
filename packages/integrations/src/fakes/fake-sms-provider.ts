import type {
  ProviderSmsWebhookEvent,
  SendSmsRequest,
  SmsOperationResult,
  SmsProvider,
} from "../providers/sms-provider";
import { signWebhookBody, verifyWebhookSignature, type WebhookHeaders } from "../webhook-signing";

const WEBHOOK_SIGNATURE_HEADER = "x-fake-signature";

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

  constructor(private readonly webhookSecret = "fake-sms-webhook-secret") {}

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
