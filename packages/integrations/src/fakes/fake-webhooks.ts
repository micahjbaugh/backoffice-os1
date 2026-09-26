// Shared inbound-webhook behavior for the fake providers (tests and local development only).
//
// Fake webhooks are JSON envelopes signed with HMAC-SHA256 in `x-fake-signature`. There is NO
// default secret: a fake must be constructed with one (the app reads FAKE_PROVIDER_WEBHOOK_SECRET
// and refuses fakes entirely in production — see ../runtime-config.ts).

import { z } from "zod";
import { signWebhookBody, verifyWebhookSignature } from "../webhook-signing";
import {
  contentTypeOf,
  WebhookPayloadError,
  type ParsedWebhookEvent,
  type WebhookRequest,
} from "../webhooks";

export const FAKE_SIGNATURE_HEADER = "x-fake-signature";
export const MIN_FAKE_SECRET_LENGTH = 16;

const envelopeSchema = z.object({
  eventType: z.string().min(1).max(64),
  eventKey: z.string().min(1).max(300),
  resourceId: z.string().min(1).max(200),
  routingAddress: z.string().min(1).max(200).nullable().default(null),
  occurredAt: z.iso.datetime({ offset: true }).nullable().default(null),
  requiresResponse: z.boolean().default(false),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type FakeWebhookEnvelope = z.input<typeof envelopeSchema>;

export function requireFakeSecret(secret: string | undefined, name: string): string {
  if (!secret || secret.length < MIN_FAKE_SECRET_LENGTH) {
    throw new Error(
      `${name} needs an explicit webhook secret of at least ${MIN_FAKE_SECRET_LENGTH} characters`,
    );
  }
  return secret;
}

export class FakeWebhookEndpoint {
  constructor(
    private readonly provider: string,
    private readonly channel: "sms" | "voice",
    private readonly secret: string,
  ) {}

  /** Build a correctly signed request body + headers, as the fake "provider" would send it. */
  sign(envelope: FakeWebhookEnvelope): { rawBody: string; headers: Record<string, string> } {
    const rawBody = JSON.stringify(envelope);
    return {
      rawBody,
      headers: {
        "content-type": "application/json",
        [FAKE_SIGNATURE_HEADER]: signWebhookBody(this.secret, rawBody),
      },
    };
  }

  verify(request: WebhookRequest): boolean {
    return verifyWebhookSignature(
      this.secret,
      request.rawBody,
      request.headers.get(FAKE_SIGNATURE_HEADER),
    );
  }

  parse(request: WebhookRequest): ParsedWebhookEvent {
    if (contentTypeOf(request.headers) !== "application/json") {
      throw new WebhookPayloadError("fake provider webhooks must be application/json");
    }
    let json: unknown;
    try {
      json = JSON.parse(request.rawBody);
    } catch {
      throw new WebhookPayloadError("fake webhook body is not valid JSON");
    }
    const parsed = envelopeSchema.safeParse(json);
    if (!parsed.success)
      throw new WebhookPayloadError(`invalid fake webhook: ${parsed.error.issues[0]?.message}`);
    const e = parsed.data;
    return {
      provider: this.provider,
      channel: this.channel,
      eventType: e.eventType,
      eventKey: e.eventKey,
      resourceId: e.resourceId,
      deliveryId: request.headers.get("x-fake-delivery-id"),
      occurredAt: e.occurredAt,
      routingAddress: e.routingAddress,
      requiresResponse: e.requiresResponse,
      payload: e.payload,
    };
  }
}
