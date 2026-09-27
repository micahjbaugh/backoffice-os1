import { describe, expect, it } from "vitest";
import {
  FakeSmsProvider,
  FakeVoiceProvider,
  ProviderRequestError,
  WebhookPayloadError,
} from "../src";

const SECRET = "a-local-dev-secret-123";

function request(signed: { rawBody: string; headers: Record<string, string> }) {
  return {
    rawBody: signed.rawBody,
    headers: new Headers(signed.headers),
    url: "http://localhost/api/webhooks/sms",
  };
}

describe("fake providers", () => {
  it("verify only requests signed with their secret", () => {
    const sms = new FakeSmsProvider(SECRET);
    const signed = sms.signWebhook({
      eventType: "sms.inbound",
      eventKey: "m1:inbound",
      resourceId: "m1",
      routingAddress: "+15125550100",
    });
    expect(sms.verifyWebhookRequest(request(signed))).toBe(true);
    expect(
      new FakeSmsProvider("another-dev-secret-456").verifyWebhookRequest(request(signed)),
    ).toBe(false);
    expect(
      sms.verifyWebhookRequest(request({ ...signed, rawBody: signed.rawBody.replace("m1", "m2") })),
    ).toBe(false);
  });

  it("parse the signed envelope and reject malformed ones", () => {
    const voice = new FakeVoiceProvider(SECRET);
    const signed = voice.signWebhook({
      eventType: "call.status",
      eventKey: "c1:status:ringing",
      resourceId: "c1",
      payload: { status: "ringing" },
    });
    expect(voice.parseWebhookRequest(request(signed))).toMatchObject({
      provider: "fake-voice",
      eventKey: "c1:status:ringing",
      payload: { status: "ringing" },
    });
    expect(() =>
      voice.parseWebhookRequest(
        request({ rawBody: "{}", headers: { "content-type": "application/json" } }),
      ),
    ).toThrow(WebhookPayloadError);
  });

  it("record every send and can script rejected/ambiguous failures", async () => {
    const sms = new FakeSmsProvider(SECRET);
    const req = {
      organizationId: "o",
      fromNumber: "a",
      toNumber: "b",
      body: "hi",
      operationId: "op",
    };
    sms.scriptFailures(
      { kind: "ambiguous", performed: true },
      { kind: "rejected", retryable: true },
    );
    await expect(sms.sendSMS(req)).rejects.toBeInstanceOf(ProviderRequestError);
    await expect(sms.sendSMS(req)).rejects.toMatchObject({ kind: "rejected", retryable: true });
    await sms.sendSMS(req);
    // The ambiguous failure really sent; the rejected one did not; the last one did.
    expect(sms.sentMessages).toHaveLength(2);
  });
});
