import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ProviderSmsWebhookEvent,
  SendSmsRequest,
  SmsOperationResult,
  SmsProvider,
} from "../providers/sms-provider";
import type { WebhookHeaders } from "../webhook-signing";

const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";

export interface TwilioSmsProviderConfig {
  accountSid: string;
  authToken: string;
  /** Full public URL Twilio posts status callbacks to; used only to validate their signature. */
  webhookUrl: string;
  /** Twilio REST API base; overridable in tests. */
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
}

interface TwilioSendMessageResponse {
  sid: string;
  status: string;
}

const STATUS_MAP: Record<string, SmsOperationResult["status"]> = {
  queued: "queued",
  accepted: "queued",
  sending: "queued",
  sent: "sent",
  delivered: "delivered",
  failed: "failed",
  undelivered: "failed",
};

/**
 * Real Twilio SmsProvider adapter. The only place the Twilio REST API is called from
 * (CLAUDE.md rule 9: provider SDKs/HTTP live only inside packages/integrations).
 */
export class TwilioSmsProvider implements SmsProvider {
  private readonly fetchFn: typeof fetch;
  private readonly resultsByIdempotencyKey = new Map<string, SmsOperationResult>();

  constructor(private readonly config: TwilioSmsProviderConfig) {
    this.fetchFn = config.fetchFn ?? fetch;
  }

  async sendSMS(request: SendSmsRequest): Promise<SmsOperationResult> {
    const key = `${request.organizationId}:${request.idempotencyKey}`;
    const existing = this.resultsByIdempotencyKey.get(key);
    if (existing) return existing;

    const baseUrl = this.config.apiBaseUrl ?? "https://api.twilio.com";
    const url = `${baseUrl}/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;
    const body = new URLSearchParams({
      To: request.toNumber,
      From: request.fromNumber,
      Body: request.body,
      StatusCallback: this.config.webhookUrl,
    });

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`,
      },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`Twilio send failed with status ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as TwilioSendMessageResponse;
    const result: SmsOperationResult = {
      providerMessageId: payload.sid,
      status: STATUS_MAP[payload.status] ?? "queued",
    };
    this.resultsByIdempotencyKey.set(key, result);
    return result;
  }

  /**
   * Twilio signs webhook requests as HMAC-SHA1(authToken, url + sorted "key" + "value" pairs),
   * base64-encoded. `rawBody` must be the original application/x-www-form-urlencoded body.
   */
  verifyWebhookSignature(rawBody: string, headers: WebhookHeaders): boolean {
    const signature = headers.get(TWILIO_SIGNATURE_HEADER);
    if (!signature) return false;

    const params = new URLSearchParams(rawBody);
    const sortedKeys = Array.from(new Set(params.keys())).sort();
    const data =
      this.config.webhookUrl + sortedKeys.map((k) => `${k}${params.get(k)}`).join("");
    const expected = createHmac("sha1", this.config.authToken).update(data).digest("base64");

    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== signatureBuffer.length) return false;
    return timingSafeEqual(expectedBuffer, signatureBuffer);
  }

  async ingestWebhook(rawEvent: unknown): Promise<ProviderSmsWebhookEvent> {
    const params = rawEvent as Record<string, string>;
    const providerEventId = params.MessageSid ?? params.SmsSid;
    if (!providerEventId) {
      throw new Error("Twilio SMS webhook payload is missing MessageSid/SmsSid");
    }
    return {
      provider: "twilio",
      providerEventId,
      payload: params,
    };
  }
}
