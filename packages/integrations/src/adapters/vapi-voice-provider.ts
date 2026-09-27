import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { errorForResponse, providerFetch } from "../outcomes";
import type {
  AssistantTurn,
  CallOperationResult,
  CallStatusSnapshot,
  InboundRoute,
  InboundRouteConfig,
  OutboundCallRequest,
  TransferCallRequest,
  VoiceProvider,
} from "../providers/voice-provider";
import {
  contentTypeOf,
  WebhookPayloadError,
  type ParsedWebhookEvent,
  type WebhookRequest,
} from "../webhooks";

/** Vapi's server-URL authentication: a shared secret echoed in this header (Bearer-style credential). */
const SECRET_HEADER = "x-vapi-secret";

export interface VapiVoiceProviderConfig {
  apiKey: string;
  webhookSecret: string;
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Which hosted LLM Vapi runs the assistant with (docs.vapi.ai/assistants/model). */
  assistantModel?: { provider: string; model: string };
}

const DEFAULT_ASSISTANT_MODEL = { provider: "openai", model: "gpt-4o-mini" };

const STATUS_MAP: Record<string, CallOperationResult["status"]> = {
  queued: "queued",
  ringing: "in_progress",
  "in-progress": "in_progress",
  forwarding: "transferred",
  ended: "failed",
};

/** Call lifecycle order for out-of-order status-update deliveries. */
export const VAPI_CALL_STATUS_RANK: Readonly<Record<string, number>> = {
  scheduled: 1,
  queued: 2,
  ringing: 3,
  "in-progress": 4,
  forwarding: 5,
  ended: 9,
};

/** Server messages that Vapi waits on for a synchronous answer (docs.vapi.ai/server-url/events). */
const SYNCHRONOUS_TYPES = new Set([
  "assistant-request",
  "tool-calls",
  "transfer-destination-request",
  "knowledge-base-request",
  "voice-request",
  "call.endpointing.request",
]);

const NORMALIZED_TYPES: Record<string, string> = {
  "status-update": "call.status",
  "end-of-call-report": "call.ended",
  "assistant-request": "call.assistant_request",
  "tool-calls": "call.tool_calls",
  "transfer-destination-request": "call.transfer_destination_request",
  hang: "call.hang",
  "transfer-update": "call.transfer_update",
};

const text = (max: number) => z.string().max(max);
const messageSchema = z.object({
  message: z
    .object({
      type: z.string().min(1).max(64),
      timestamp: z.union([z.number(), z.string()]).optional(),
      status: text(64).optional(),
      endedReason: text(200).optional(),
      summary: text(20_000).optional(),
      transcript: text(200_000).optional(),
      durationSeconds: z.number().nonnegative().optional(),
      startedAt: text(64).optional(),
      endedAt: text(64).optional(),
      call: z.object({
        id: z.string().min(1).max(200),
        phoneNumberId: text(200).optional(),
        customer: z.object({ number: text(64).optional() }).optional(),
      }),
      phoneNumber: z.object({ id: text(200).optional(), number: text(64).optional() }).optional(),
      customer: z.object({ number: text(64).optional() }).optional(),
      artifact: z
        .object({ transcript: text(200_000).optional(), recordingUrl: text(2048).optional() })
        .partial()
        .optional(),
      analysis: z
        .object({ summary: text(20_000).optional() })
        .partial()
        .optional(),
      toolCallList: z
        .array(z.object({ id: z.string().max(200) }).passthrough())
        .max(50)
        .optional(),
    })
    .passthrough(),
});

function isoTimestamp(value: number | string | undefined): string | null {
  if (value === undefined) return null;
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Real Vapi voice adapter. The only place the Vapi REST API is called (CLAUDE.md rule 9). */
export class VapiVoiceProvider implements VoiceProvider {
  readonly provider = "vapi";
  readonly channel = "voice" as const;
  private readonly fetchFn: typeof fetch;
  private readonly assistantModel: { provider: string; model: string };

  constructor(private readonly config: VapiVoiceProviderConfig) {
    this.fetchFn = config.fetchFn ?? fetch;
    this.assistantModel = config.assistantModel ?? DEFAULT_ASSISTANT_MODEL;
  }

  private get baseUrl(): string {
    return this.config.apiBaseUrl ?? "https://api.vapi.ai";
  }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` };
  }

  /**
   * Vapi does not sign bodies with this credential type; it sends the configured shared secret in
   * `x-vapi-secret`. Constant-time comparison; fails closed on a missing/short header.
   */
  verifyWebhookRequest(request: WebhookRequest): boolean {
    const provided = request.headers.get(SECRET_HEADER);
    if (!provided) return false;
    const expected = Buffer.from(this.config.webhookSecret);
    const actual = Buffer.from(provided);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  parseWebhookRequest(request: WebhookRequest): ParsedWebhookEvent {
    if (contentTypeOf(request.headers) !== "application/json") {
      throw new WebhookPayloadError("Vapi server messages must be application/json");
    }
    let json: unknown;
    try {
      json = JSON.parse(request.rawBody);
    } catch {
      throw new WebhookPayloadError("Vapi server message is not valid JSON");
    }
    const parsed = messageSchema.safeParse(json);
    if (!parsed.success) {
      throw new WebhookPayloadError(
        `invalid Vapi server message: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
      );
    }
    const m = parsed.data.message;
    const callId = m.call.id;
    const occurredAt = isoTimestamp(m.timestamp);
    // Vapi sends no per-event id. Derive one that is stable across retries of the same event and
    // distinct across genuinely different events about the same call.
    const discriminator =
      m.type === "status-update"
        ? (m.status ?? "unknown")
        : m.type === "end-of-call-report"
          ? "final"
          : m.type === "tool-calls" && m.toolCallList?.length
            ? m.toolCallList.map((t) => t.id).join(",")
            : (occurredAt ??
              createHash("sha256").update(request.rawBody).digest("hex").slice(0, 32));

    return {
      provider: this.provider,
      channel: "voice",
      eventType: NORMALIZED_TYPES[m.type] ?? `vapi.${m.type}`,
      eventKey: `${callId}:${m.type}:${discriminator}`,
      resourceId: callId,
      deliveryId: null,
      occurredAt,
      routingAddress: m.phoneNumber?.number ?? m.call.phoneNumberId ?? m.phoneNumber?.id ?? null,
      requiresResponse: SYNCHRONOUS_TYPES.has(m.type),
      payload: {
        callId,
        type: m.type,
        status: m.status ?? null,
        statusRank: m.status ? (VAPI_CALL_STATUS_RANK[m.status] ?? 0) : null,
        endedReason: m.endedReason ?? null,
        customerNumber: m.call.customer?.number ?? m.customer?.number ?? null,
        phoneNumber: m.phoneNumber?.number ?? null,
        summary: m.analysis?.summary ?? m.summary ?? null,
        transcript: m.artifact?.transcript ?? m.transcript ?? null,
        recordingUrl: m.artifact?.recordingUrl ?? null,
        durationSeconds: m.durationSeconds ?? null,
        startedAt: isoTimestamp(m.startedAt),
        endedAt: isoTimestamp(m.endedAt),
        toolCallIds: m.toolCallList?.map((t) => t.id) ?? [],
      },
    };
  }

  /** Vapi's assistant-request wire format (docs.vapi.ai/server-url/events#assistant-request). */
  buildAssistantResponse(turn: AssistantTurn): Record<string, unknown> {
    return {
      assistant: {
        name: "receptionist",
        firstMessage: turn.firstMessage,
        model: {
          provider: this.assistantModel.provider,
          model: this.assistantModel.model,
          messages: [{ role: "system", content: turn.systemPrompt }],
          tools: turn.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        },
      },
    };
  }

  async createInboundRoute(config: InboundRouteConfig): Promise<InboundRoute> {
    const response = await providerFetch(
      "vapi",
      this.fetchFn,
      `${this.baseUrl}/phone-number`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          provider: "byo-phone-number",
          number: config.phoneNumber,
          server: { url: config.webhookUrl, secret: this.config.webhookSecret },
        }),
      },
      this.config.timeoutMs,
    );
    if (!response.ok) throw errorForResponse("vapi", response.status, await response.text());
    const payload = (await response.json()) as { id: string; number: string };
    return { providerRouteId: payload.id, phoneNumber: payload.number };
  }

  /** Vapi's call API has no request idempotency key; the outbox decides whether a call is safe. */
  async initiateOutboundCall(request: OutboundCallRequest): Promise<CallOperationResult> {
    const response = await providerFetch(
      "vapi",
      this.fetchFn,
      `${this.baseUrl}/call`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          phoneNumber: { number: request.fromNumber },
          customer: { number: request.toNumber },
          metadata: { operationId: request.operationId },
        }),
      },
      this.config.timeoutMs,
    );
    if (!response.ok) throw errorForResponse("vapi", response.status, await response.text());
    const payload = (await response.json()) as { id: string; status: string };
    return { providerCallId: payload.id, status: STATUS_MAP[payload.status] ?? "queued" };
  }

  async transferCall(request: TransferCallRequest): Promise<CallOperationResult> {
    const response = await providerFetch(
      "vapi",
      this.fetchFn,
      `${this.baseUrl}/call/${encodeURIComponent(request.providerCallId)}/control`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          type: "transfer",
          destination: { type: "number", number: request.toNumber },
        }),
      },
      this.config.timeoutMs,
    );
    if (!response.ok) throw errorForResponse("vapi", response.status, await response.text());
    const payload = (await response.json().catch(() => ({}))) as { id?: string; status?: string };
    return {
      providerCallId: payload.id ?? request.providerCallId,
      status: (payload.status && STATUS_MAP[payload.status]) || "transferred",
    };
  }

  async getCall(providerCallId: string): Promise<CallStatusSnapshot> {
    const response = await providerFetch(
      "vapi",
      this.fetchFn,
      `${this.baseUrl}/call/${encodeURIComponent(providerCallId)}`,
      { method: "GET", headers: this.headers() },
      this.config.timeoutMs,
    );
    if (!response.ok) throw errorForResponse("vapi", response.status, await response.text());
    const payload = (await response.json()) as { id: string; status: string; endedReason?: string };
    return {
      providerCallId: payload.id,
      status: payload.status,
      endedReason: payload.endedReason ?? null,
    };
  }
}
