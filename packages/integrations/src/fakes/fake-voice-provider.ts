import { ProviderRequestError } from "../outcomes";
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
import type { ParsedWebhookEvent, WebhookRequest } from "../webhooks";
import type { ScriptedFailure } from "./fake-sms-provider";
import { FakeWebhookEndpoint, requireFakeSecret, type FakeWebhookEnvelope } from "./fake-webhooks";

/** In-memory VoiceProvider for tests and local development; records every provider request. */
export class FakeVoiceProvider implements VoiceProvider {
  readonly provider = "fake-voice";
  readonly channel = "voice" as const;
  private readonly endpoint: FakeWebhookEndpoint;
  private readonly failures: ScriptedFailure[] = [];
  private readonly calls = new Map<string, CallStatusSnapshot>();
  readonly transfers: TransferCallRequest[] = [];
  readonly outboundCalls: OutboundCallRequest[] = [];
  private counter = 0;

  constructor(webhookSecret: string) {
    this.endpoint = new FakeWebhookEndpoint(
      this.provider,
      "voice",
      requireFakeSecret(webhookSecret, "FakeVoiceProvider"),
    );
  }

  scriptFailures(...failures: ScriptedFailure[]): void {
    this.failures.push(...failures);
  }

  /** Test helper: make the fake provider report a call's current state. */
  setCallStatus(providerCallId: string, status: string, endedReason: string | null = null): void {
    this.calls.set(providerCallId, { providerCallId, status, endedReason });
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

  private maybeFail(perform: () => void): void {
    const failure = this.failures.shift();
    if (!failure) return;
    if (failure.performed) perform();
    throw new ProviderRequestError(
      `scripted ${failure.kind} failure`,
      failure.kind,
      failure.retryable ?? false,
    );
  }

  /** Deterministic, inspectable stand-in for the real wire format (see VapiVoiceProvider). */
  buildAssistantResponse(turn: AssistantTurn): Record<string, unknown> {
    return {
      assistant: {
        firstMessage: turn.firstMessage,
        systemPrompt: turn.systemPrompt,
        tools: turn.tools.map((tool) => tool.name),
      },
    };
  }

  async createInboundRoute(config: InboundRouteConfig): Promise<InboundRoute> {
    return { providerRouteId: `fake-route-${++this.counter}`, phoneNumber: config.phoneNumber };
  }

  async initiateOutboundCall(request: OutboundCallRequest): Promise<CallOperationResult> {
    this.maybeFail(() => this.outboundCalls.push(request));
    this.outboundCalls.push(request);
    const providerCallId = `fake-call-${++this.counter}`;
    this.setCallStatus(providerCallId, "queued");
    return { providerCallId, status: "queued" };
  }

  async transferCall(request: TransferCallRequest): Promise<CallOperationResult> {
    const perform = () => {
      this.transfers.push(request);
      this.setCallStatus(request.providerCallId, "forwarding");
    };
    this.maybeFail(perform);
    perform();
    return { providerCallId: request.providerCallId, status: "transferred" };
  }

  async getCall(providerCallId: string): Promise<CallStatusSnapshot> {
    const call = this.calls.get(providerCallId);
    if (!call)
      throw new ProviderRequestError(`unknown call ${providerCallId}`, "rejected", false, 404);
    return call;
  }
}
