import { describe, expect, it } from "vitest";
import { FakeSmsProvider } from "../src/fakes/fake-sms-provider";
import { FakeVoiceProvider } from "../src/fakes/fake-voice-provider";

describe("FakeVoiceProvider", () => {
  it("creates inbound routes", async () => {
    const provider = new FakeVoiceProvider();
    const route = await provider.createInboundRoute({
      organizationId: "org-1",
      phoneNumber: "+15551234567",
      webhookUrl: "https://example.test/webhooks/voice",
    });
    expect(route.phoneNumber).toBe("+15551234567");
    expect(route.providerRouteId).toMatch(/^fake-route-/);
  });

  it("is idempotent for outbound calls with the same key", async () => {
    const provider = new FakeVoiceProvider();
    const request = {
      organizationId: "org-1",
      fromNumber: "+15550000000",
      toNumber: "+15551111111",
      idempotencyKey: "call-key-1",
    };
    const first = await provider.initiateOutboundCall(request);
    const second = await provider.initiateOutboundCall(request);
    expect(second).toEqual(first);
  });

  it("distinguishes idempotency keys across organizations", async () => {
    const provider = new FakeVoiceProvider();
    const base = {
      fromNumber: "+15550000000",
      toNumber: "+15551111111",
      idempotencyKey: "same-key",
    };
    const orgA = await provider.initiateOutboundCall({ ...base, organizationId: "org-a" });
    const orgB = await provider.initiateOutboundCall({ ...base, organizationId: "org-b" });
    expect(orgA.providerCallId).not.toBe(orgB.providerCallId);
  });

  it("transfers a call and ingests a webhook", async () => {
    const provider = new FakeVoiceProvider();
    const transfer = await provider.transferCall({
      organizationId: "org-1",
      providerCallId: "fake-call-1",
      toNumber: "+15552222222",
      idempotencyKey: "transfer-key-1",
    });
    expect(transfer.status).toBe("transferred");

    const event = await provider.ingestWebhook({
      providerEventId: "evt-1",
      payload: { kind: "call.status" },
    });
    expect(event.provider).toBe("fake-voice");
    expect(provider.webhookLog).toHaveLength(1);
  });
});

describe("FakeSmsProvider", () => {
  it("is idempotent for sends with the same key", async () => {
    const provider = new FakeSmsProvider();
    const request = {
      organizationId: "org-1",
      fromNumber: "+15550000000",
      toNumber: "+15551111111",
      body: "hello",
      idempotencyKey: "sms-key-1",
    };
    const first = await provider.sendSMS(request);
    const second = await provider.sendSMS(request);
    expect(second).toEqual(first);
    expect(provider.sentMessages).toHaveLength(1);
  });

  it("ingests a webhook event", async () => {
    const provider = new FakeSmsProvider();
    const event = await provider.ingestWebhook({
      providerEventId: "evt-2",
      payload: { kind: "message.delivered" },
    });
    expect(event.provider).toBe("fake-sms");
    expect(provider.webhookLog).toHaveLength(1);
  });
});
