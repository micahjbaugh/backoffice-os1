import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { errorForResponse, providerFetch } from "../outcomes";
import type { SendSmsRequest, SmsOperationResult, SmsProvider } from "../providers/sms-provider";
import {
  contentTypeOf,
  WebhookPayloadError,
  type ParsedWebhookEvent,
  type WebhookRequest,
} from "../webhooks";

const SIGNATURE_HEADER = "x-twilio-signature";
/** Twilio's retry marker: the same value on every retry of one webhook delivery. */
const IDEMPOTENCY_HEADER = "i-twilio-idempotency-token";

export interface TwilioSmsProviderConfig {
  accountSid: string;
  authToken: string;
  /**
   * The public URL configured in Twilio for this webhook (inbound "A message comes in" and the
   * status callback), without query string. Signatures cover this exact URL plus any query string.
   */
  webhookUrl: string;
  /** Twilio REST API base; overridable in tests. */
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const STATUS_MAP: Record<string, SmsOperationResult["status"]> = {
  queued: "queued",
  accepted: "queued",
  scheduled: "queued",
  sending: "queued",
  sent: "sent",
  delivered: "delivered",
  read: "delivered",
  failed: "failed",
  undelivered: "failed",
  canceled: "failed",
};

/** Delivery statuses in lifecycle order, so late or out-of-order callbacks never move a message backwards. */
export const TWILIO_STATUS_RANK: Readonly<Record<string, number>> = {
  accepted: 1,
  scheduled: 1,
  queued: 2,
  sending: 3,
  sent: 4,
  delivered: 5,
  read: 6,
  undelivered: 7,
  failed: 7,
  canceled: 7,
};

const sid = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[0-9a-fA-F]{32}$`));
const phoneOrAddress = z.string().trim().min(1).max(64);

const inboundSchema = z.object({
  MessageSid: z.union([sid("SM"), sid("MM")]),
  AccountSid: sid("AC"),
  From: phoneOrAddress,
  To: phoneOrAddress,
  Body: z.string().max(1600),
  NumMedia: z.coerce.number().int().min(0).max(10).default(0),
});

const statusSchema = z.object({
  MessageSid: z.union([sid("SM"), sid("MM")]),
  AccountSid: sid("AC"),
  MessageStatus: z.string().refine((s) => s in TWILIO_STATUS_RANK, "unknown MessageStatus"),
  From: phoneOrAddress.optional(),
  To: phoneOrAddress.optional(),
  ErrorCode: z.string().max(16).optional(),
});

/** Parse a form body keeping every value per key (Twilio signs all of them). */
function formEntries(rawBody: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  for (const [key, value] of new URLSearchParams(rawBody)) {
    entries.set(key, [...(entries.get(key) ?? []), value]);
  }
  return entries;
}

/** Real Twilio SMS adapter. The only place the Twilio REST API is called (CLAUDE.md rule 9). */
export class TwilioSmsProvider implements SmsProvider {
  readonly provider = "twilio";
  readonly channel = "sms" as const;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: TwilioSmsProviderConfig) {
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /** URL Twilio signed: the configured public URL plus the query string of this request. */
  private signedUrl(requestUrl: string): string {
    const search = new URL(requestUrl, "http://placeholder.invalid").search;
    return `${this.config.webhookUrl}${search}`;
  }

  /**
   * HMAC-SHA1(authToken, url + for each key in sorted order: key + value (values sorted when a key
   * repeats, de-duplicated)), base64 — Twilio's documented scheme for application/x-www-form-urlencoded webhooks.
   */
  verifyWebhookRequest(request: WebhookRequest): boolean {
    const signature = request.headers.get(SIGNATURE_HEADER);
    if (!signature) return false;
    if (contentTypeOf(request.headers) !== "application/x-www-form-urlencoded") return false;
    const entries = formEntries(request.rawBody);
    const data =
      this.signedUrl(request.url) +
      [...entries.keys()]
        .sort()
        // Matches twilio-node's toFormUrlEncodedParam: repeated values are de-duplicated, then sorted.
        .map((key) =>
          [...new Set(entries.get(key) ?? [])]
            .sort()
            .map((v) => `${key}${v}`)
            .join(""),
        )
        .join("");
    const expected = Buffer.from(
      createHmac("sha1", this.config.authToken).update(Buffer.from(data, "utf-8")).digest("base64"),
    );
    const provided = Buffer.from(signature);
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  parseWebhookRequest(request: WebhookRequest): ParsedWebhookEvent {
    if (contentTypeOf(request.headers) !== "application/x-www-form-urlencoded") {
      throw new WebhookPayloadError(
        "Twilio messaging webhooks must be application/x-www-form-urlencoded",
      );
    }
    const entries = formEntries(request.rawBody);
    const params = Object.fromEntries([...entries].map(([k, v]) => [k, v[0]]));
    if (params.AccountSid !== undefined && params.AccountSid !== this.config.accountSid) {
      throw new WebhookPayloadError("webhook is for a different Twilio account");
    }
    const deliveryId = request.headers.get(IDEMPOTENCY_HEADER);
    const operationId = new URL(request.url, "http://placeholder.invalid").searchParams.get("op");

    // Inbound messages carry a Body; delivery status callbacks carry a MessageStatus and no Body.
    if ("Body" in params) {
      const parsed = inboundSchema.safeParse(params);
      if (!parsed.success)
        throw new WebhookPayloadError(`invalid inbound SMS: ${parsed.error.issues[0]?.message}`);
      const p = parsed.data;
      const mediaUrls = Array.from({ length: p.NumMedia }, (_, i) => params[`MediaUrl${i}`]).filter(
        (u): u is string => typeof u === "string" && u.length > 0,
      );
      return {
        provider: this.provider,
        channel: "sms",
        eventType: "sms.inbound",
        eventKey: `${p.MessageSid}:inbound`,
        resourceId: p.MessageSid,
        deliveryId,
        occurredAt: null,
        routingAddress: p.To,
        requiresResponse: false,
        payload: { messageSid: p.MessageSid, from: p.From, to: p.To, body: p.Body, mediaUrls },
      };
    }

    const parsed = statusSchema.safeParse(params);
    if (!parsed.success)
      throw new WebhookPayloadError(
        `invalid SMS status callback: ${parsed.error.issues[0]?.message}`,
      );
    const p = parsed.data;
    return {
      provider: this.provider,
      channel: "sms",
      eventType: "sms.status",
      eventKey: `${p.MessageSid}:${p.MessageStatus}`,
      resourceId: p.MessageSid,
      deliveryId,
      occurredAt: null,
      routingAddress: p.From ?? null,
      requiresResponse: false,
      payload: {
        messageSid: p.MessageSid,
        status: p.MessageStatus,
        statusRank: TWILIO_STATUS_RANK[p.MessageStatus],
        errorCode: p.ErrorCode ?? null,
        operationId,
      },
    };
  }

  /**
   * One Messages API request. Twilio's Messages API has no request idempotency key, so the outbox
   * decides whether a send is safe; the operation id rides on the status-callback URL so delivery
   * callbacks can reconcile a send whose response was lost.
   */
  async sendSMS(request: SendSmsRequest): Promise<SmsOperationResult> {
    const baseUrl = this.config.apiBaseUrl ?? "https://api.twilio.com";
    const url = `${baseUrl}/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;
    const statusCallback = `${this.config.webhookUrl}?op=${encodeURIComponent(request.operationId)}`;
    const body = new URLSearchParams({
      To: request.toNumber,
      From: request.fromNumber,
      Body: request.body,
      StatusCallback: statusCallback,
    });
    const response = await providerFetch(
      "twilio",
      this.fetchFn,
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`,
        },
        body: body.toString(),
      },
      this.config.timeoutMs,
    );
    if (!response.ok) throw errorForResponse("twilio", response.status, await response.text());
    const payload = (await response.json()) as { sid: string; status: string };
    return { providerMessageId: payload.sid, status: STATUS_MAP[payload.status] ?? "queued" };
  }
}
