import { timingSafeEqual } from "node:crypto";
import type {
  CallOperationResult,
  InboundRoute,
  InboundRouteConfig,
  OutboundCallRequest,
  ProviderWebhookEvent,
  TransferCallRequest,
  VoiceProvider,
} from "../providers/voice-provider";
import type { WebhookHeaders } from "../webhook-signing";

const VAPI_SECRET_HEADER = "x-vapi-secret";

export interface VapiVoiceProviderConfig {
  apiKey: string;
  /** Shared secret Vapi echoes back on every webhook (configured as the phone number's server secret). */
  webhookSecret: string;
  /** Vapi REST API base; overridable in tests. */
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
}

interface VapiPhoneNumberResponse {
  id: string;
  number: string;
}

interface VapiCallResponse {
  id: string;
  status: string;
}

const STATUS_MAP: Record<string, CallOperationResult["status"]> = {
  queued: "queued",
  ringing: "in_progress",
  "in-progress": "in_progress",
  forwarding: "transferred",
  ended: "failed",
};

/**
 * Real Vapi VoiceProvider adapter. The only place the Vapi REST API is called from
 * (CLAUDE.md rule 9: provider SDKs/HTTP live only inside packages/integrations).
 */
export class VapiVoiceProvider implements VoiceProvider {
  private readonly fetchFn: typeof fetch;
  private readonly callsByIdempotencyKey = new Map<string, CallOperationResult>();

  constructor(private readonly config: VapiVoiceProviderConfig) {
    this.fetchFn = config.fetchFn ?? fetch;
  }

  private get baseUrl(): string {
    return this.config.apiBaseUrl ?? "https://api.vapi.ai";
  }

  private authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  async createInboundRoute(config: InboundRouteConfig): Promise<InboundRoute> {
    const response = await this.fetchFn(`${this.baseUrl}/phone-number`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        provider: "byo-phone-number",
        number: config.phoneNumber,
        server: { url: config.webhookUrl, secret: this.config.webhookSecret },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Vapi phone number creation failed with status ${response.status}: ${await response.text()}`,
      );
    }

    const payload = (await response.json()) as VapiPhoneNumberResponse;
    return { providerRouteId: payload.id, phoneNumber: payload.number };
  }

  async initiateOutboundCall(request: OutboundCallRequest): Promise<CallOperationResult> {
    const key = `${request.organizationId}:${request.idempotencyKey}`;
    const existing = this.callsByIdempotencyKey.get(key);
    if (existing) return existing;

    const response = await this.fetchFn(`${this.baseUrl}/call`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        phoneNumber: { number: request.fromNumber },
        customer: { number: request.toNumber },
      }),
    });

    if (!response.ok) {
      throw new Error(`Vapi call creation failed with status ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as VapiCallResponse;
    const result: CallOperationResult = {
      providerCallId: payload.id,
      status: STATUS_MAP[payload.status] ?? "queued",
    };
    this.callsByIdempotencyKey.set(key, result);
    return result;
  }

  async transferCall(request: TransferCallRequest): Promise<CallOperationResult> {
    const key = `${request.organizationId}:${request.idempotencyKey}`;
    const existing = this.callsByIdempotencyKey.get(key);
    if (existing) return existing;

    const response = await this.fetchFn(`${this.baseUrl}/call/${request.providerCallId}/control`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ type: "transfer", destination: { type: "number", number: request.toNumber } }),
    });

    if (!response.ok) {
      throw new Error(`Vapi call transfer failed with status ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as VapiCallResponse;
    const result: CallOperationResult = {
      providerCallId: payload.id,
      status: STATUS_MAP[payload.status] ?? "transferred",
    };
    this.callsByIdempotencyKey.set(key, result);
    return result;
  }

  /**
   * Vapi does not sign the webhook body; it echoes back the shared secret configured on the
   * phone number's server URL in the `x-vapi-secret` header. Comparison is constant-time and
   * fails closed when the header is missing or the wrong length.
   */
  verifyWebhookSignature(_rawBody: string, headers: WebhookHeaders): boolean {
    const secret = headers.get(VAPI_SECRET_HEADER);
    if (!secret) return false;

    const expectedBuffer = Buffer.from(this.config.webhookSecret);
    const secretBuffer = Buffer.from(secret);
    if (expectedBuffer.length !== secretBuffer.length) return false;
    return timingSafeEqual(expectedBuffer, secretBuffer);
  }

  async ingestWebhook(rawEvent: unknown): Promise<ProviderWebhookEvent> {
    const event = rawEvent as { message?: { call?: { id?: string }; type?: string } };
    const providerCallId = event.message?.call?.id;
    if (!providerCallId) {
      throw new Error("Vapi webhook payload is missing message.call.id");
    }
    return {
      provider: "vapi",
      providerEventId: providerCallId,
      payload: event.message,
    };
  }
}
