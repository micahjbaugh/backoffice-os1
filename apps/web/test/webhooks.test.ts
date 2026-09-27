// HTTP layer of the webhook flow: the route answers the provider correctly for every outcome and only
// acknowledges after durable acceptance. Storage and processing are mocked here; they are covered
// against a real database in packages/core and packages/workflows.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSmsProvider, ProviderConfigError, TwilioSmsProvider } from "@backoffice/integrations";
import {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WEBHOOK_URL,
  twilioInboundSms,
  twilioRequest,
} from "../../../packages/integrations/test/fixtures/providers";

const { acceptWebhookEvent, runAs } = vi.hoisted(() => ({
  acceptWebhookEvent: vi.fn(),
  runAs: vi.fn((_db: unknown, _actor: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));

// "server-only" throws outside Next's bundler; stub it so src/server modules can be unit tested.
vi.mock("server-only", () => ({}));
vi.mock("@backoffice/core", () => ({ acceptWebhookEvent, runAs }));
vi.mock("@backoffice/workflows", () => ({ processWebhookEvents: vi.fn() }));
vi.mock("../src/server/db", () => ({ db: () => ({}) }));

const { handleProviderWebhook, MAX_WEBHOOK_BYTES } = await import("../src/server/webhook-route");

const SECRET = "web-test-webhook-secret-01";
const fake = new FakeSmsProvider(SECRET);
const twilio = new TwilioSmsProvider({
  accountSid: TWILIO_ACCOUNT_SID,
  authToken: TWILIO_AUTH_TOKEN,
  webhookUrl: TWILIO_WEBHOOK_URL,
});
const opts = { processInBackground: false };

function fakeRequest(rawBody: string, headers: Record<string, string>): Request {
  return new Request("https://app.example.com/api/webhooks/sms", {
    method: "POST",
    body: rawBody,
    headers,
  });
}

const envelope = {
  eventType: "sms.inbound",
  eventKey: "m1:inbound",
  resourceId: "m1",
  routingAddress: "+15125550100",
};

describe("handleProviderWebhook", () => {
  beforeEach(() => {
    acceptWebhookEvent
      .mockReset()
      .mockResolvedValue({ event: { id: "evt-1" }, duplicate: false, payloadMismatch: false });
    runAs.mockClear();
  });

  it("fails closed with 503 when providers are not configured, storing nothing", async () => {
    const res = await handleProviderWebhook(
      () => {
        throw new ProviderConfigError("missing");
      },
      fakeRequest("{}", {}),
      opts,
    );
    expect(res.status).toBe(503);
    expect(acceptWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects an invalid or missing signature with 401", async () => {
    const signed = fake.signWebhook(envelope);
    const tampered = await handleProviderWebhook(
      () => fake,
      fakeRequest(signed.rawBody.replace("m1", "m2"), signed.headers),
      opts,
    );
    expect(tampered.status).toBe(401);
    const unsigned = await handleProviderWebhook(
      () => fake,
      fakeRequest(signed.rawBody, { "content-type": "application/json" }),
      opts,
    );
    expect(unsigned.status).toBe(401);
    expect(acceptWebhookEvent).not.toHaveBeenCalled();
  });

  it("answers a validly signed but malformed payload with 400", async () => {
    const rawBody = JSON.stringify({ nope: true });
    const res = await handleProviderWebhook(
      () => fake,
      fakeRequest(rawBody, {
        "content-type": "application/json",
        "x-fake-signature": fake.signWebhook(envelope).headers["x-fake-signature"] as string,
      }),
      opts,
    );
    expect(res.status).toBe(401); // signature is over a different body
    const { signWebhookBody } = await import("@backoffice/integrations");
    const res2 = await handleProviderWebhook(
      () => fake,
      fakeRequest(rawBody, {
        "content-type": "application/json",
        "x-fake-signature": signWebhookBody(SECRET, rawBody),
      }),
      opts,
    );
    expect(res2.status).toBe(400);
    expect(acceptWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies with 413 before doing anything else", async () => {
    const res = await handleProviderWebhook(
      () => fake,
      fakeRequest("x".repeat(MAX_WEBHOOK_BYTES + 1), {}),
      opts,
    );
    expect(res.status).toBe(413);
  });

  it("acknowledges only after durable acceptance, passing the raw body for hashing", async () => {
    const signed = fake.signWebhook(envelope);
    const res = await handleProviderWebhook(
      () => fake,
      fakeRequest(signed.rawBody, signed.headers),
      opts,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true, duplicate: false });
    expect(acceptWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventKey: "m1:inbound", rawBody: signed.rawBody }),
    );
  });

  it("returns 500 when the event cannot be stored, so the provider retries", async () => {
    acceptWebhookEvent.mockRejectedValue(new Error("database down"));
    const signed = fake.signWebhook(envelope);
    const res = await handleProviderWebhook(
      () => fake,
      fakeRequest(signed.rawBody, signed.headers),
      opts,
    );
    expect(res.status).toBe(500);
  });

  it("accepts a real form-encoded Twilio inbound SMS (previously rejected as non-JSON) and answers TwiML", async () => {
    const t = twilioRequest(twilioInboundSms());
    const request = new Request(t.url, { method: "POST", body: t.rawBody, headers: t.headers });
    const res = await handleProviderWebhook(() => twilio, request, opts);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/xml");
    await expect(res.text()).resolves.toBe("<Response/>");
    expect(acceptWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: "twilio", eventType: "sms.inbound" }),
    );
  });

  it("answers a synchronous event with the caller's reply instead of the default ack", async () => {
    const signed = fake.signWebhook({ ...envelope, requiresResponse: true });
    const answerSynchronousEvent = vi.fn().mockResolvedValue({ assistant: { firstMessage: "hi" } });
    const res = await handleProviderWebhook(
      () => fake,
      fakeRequest(signed.rawBody, signed.headers),
      {
        ...opts,
        answerSynchronousEvent,
      },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ assistant: { firstMessage: "hi" } });
    expect(answerSynchronousEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventKey: "m1:inbound" }),
    );
  });

  it("falls back to the default ack when the synchronous handler declines to answer", async () => {
    const signed = fake.signWebhook({ ...envelope, requiresResponse: true });
    const res = await handleProviderWebhook(
      () => fake,
      fakeRequest(signed.rawBody, signed.headers),
      {
        ...opts,
        answerSynchronousEvent: async () => null,
      },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true, duplicate: false });
  });
});
