import { ProviderRequestError, type ProviderFailureKind } from "../outcomes";
import type { SendSmsRequest, SmsOperationResult, SmsProvider } from "../providers/sms-provider";
import type { ParsedWebhookEvent, WebhookRequest } from "../webhooks";
import { FakeWebhookEndpoint, requireFakeSecret, type FakeWebhookEnvelope } from "./fake-webhooks";

export interface ScriptedFailure {
  kind: ProviderFailureKind;
  retryable?: boolean;
  /** For "ambiguous" failures: whether the fake actually performed the side effect first. */
  performed?: boolean;
}

/**
 * In-memory SmsProvider for tests and local development. Records every send (including repeats,
 * so tests can prove the outbox never sends twice) and can script provider failures.
 */
export class FakeSmsProvider implements SmsProvider {
  readonly provider = "fake-sms";
  readonly channel = "sms" as const;
  private readonly endpoint: FakeWebhookEndpoint;
  private readonly sends: SendSmsRequest[] = [];
  private readonly failures: ScriptedFailure[] = [];
  private counter = 0;

  constructor(webhookSecret: string) {
    this.endpoint = new FakeWebhookEndpoint(
      this.provider,
      "sms",
      requireFakeSecret(webhookSecret, "FakeSmsProvider"),
    );
  }

  /** Queue failures for the next sendSMS calls, in order. */
  scriptFailures(...failures: ScriptedFailure[]): void {
    this.failures.push(...failures);
  }

  signWebhook(envelope: FakeWebhookEnvelope): { rawBody: string; headers: Record<string, string> } {
    return this.endpoint.sign(envelope);
  }

  verifyWebhookRequest(request: WebhookRequest): boolean {
    return this.endpoint.verify(request);
  }

  parseWebhookRequest(request: WebhookRequest): ParsedWebhookEvent {
    return this.endpoint.parse(request);
  }

  async sendSMS(request: SendSmsRequest): Promise<SmsOperationResult> {
    const failure = this.failures.shift();
    if (failure?.performed) this.sends.push(request);
    if (failure) {
      throw new ProviderRequestError(
        `scripted ${failure.kind} failure`,
        failure.kind,
        failure.retryable ?? false,
      );
    }
    this.sends.push(request);
    return { providerMessageId: `fake-msg-${++this.counter}`, status: "queued" };
  }

  get sentMessages(): readonly SendSmsRequest[] {
    return this.sends;
  }
}
