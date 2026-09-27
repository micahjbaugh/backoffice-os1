import { describe, expect, it, vi } from "vitest";
import { VapiVoiceProvider, WebhookPayloadError } from "../src";
import {
  BUSINESS_NUMBER,
  T0,
  CUSTOMER_NUMBER,
  VAPI_CALL_ID,
  VAPI_WEBHOOK_SECRET,
  vapiAssistantRequest,
  vapiEndOfCallReport,
  vapiRequest,
  vapiStatusUpdate,
} from "./fixtures/providers";

const provider = (fetchFn?: typeof fetch) =>
  new VapiVoiceProvider({
    apiKey: "vapi-api-key-for-tests-000001",
    webhookSecret: VAPI_WEBHOOK_SECRET,
    fetchFn,
  });

describe("Vapi server-URL authentication", () => {
  it("accepts the configured x-vapi-secret and rejects anything else", () => {
    expect(provider().verifyWebhookRequest(vapiRequest(vapiStatusUpdate("ringing")))).toBe(true);
    expect(
      provider().verifyWebhookRequest(
        vapiRequest(vapiStatusUpdate("ringing"), "wrong-secret-of-same-len"),
      ),
    ).toBe(false);
    const req = vapiRequest(vapiStatusUpdate("ringing"));
    req.headers.delete("x-vapi-secret");
    expect(provider().verifyWebhookRequest(req)).toBe(false);
  });
});

describe("Vapi event identity (Vapi sends no event id)", () => {
  it("distinct lifecycle updates about one call get distinct identities; resource id is the call", () => {
    const events = ["ringing", "in-progress", "ended"].map((s) =>
      provider().parseWebhookRequest(vapiRequest(vapiStatusUpdate(s))),
    );
    expect(new Set(events.map((e) => e.eventKey)).size).toBe(3);
    expect(events.every((e) => e.resourceId === VAPI_CALL_ID)).toBe(true);
    const report = provider().parseWebhookRequest(vapiRequest(vapiEndOfCallReport()));
    expect(events.map((e) => e.eventKey)).not.toContain(report.eventKey);
  });

  it("a retry of the same event has the same identity", () => {
    const a = provider().parseWebhookRequest(vapiRequest(vapiStatusUpdate("in-progress", 1)));
    const b = provider().parseWebhookRequest(vapiRequest(vapiStatusUpdate("in-progress", 1)));
    expect(a.eventKey).toBe(b.eventKey);
  });

  it("normalizes status updates with lifecycle rank for out-of-order handling", () => {
    const e = provider().parseWebhookRequest(vapiRequest(vapiStatusUpdate("in-progress")));
    expect(e).toMatchObject({
      eventType: "call.status",
      routingAddress: BUSINESS_NUMBER,
      requiresResponse: false,
      payload: { status: "in-progress", statusRank: 4, customerNumber: CUSTOMER_NUMBER },
    });
    expect(e.occurredAt).toBe(new Date(1_790_000_000_000).toISOString());
  });

  it("extracts the end-of-call report fields needed for disposition", () => {
    const e = provider().parseWebhookRequest(vapiRequest(vapiEndOfCallReport()));
    expect(e).toMatchObject({
      eventType: "call.ended",
      payload: {
        endedReason: "customer-ended-call",
        durationSeconds: 300,
        summary: "Caller asked for a quote to grade a 200 ft driveway.",
        recordingUrl: "https://storage.vapi.ai/recordings/4b8f3c2e.wav",
        startedAt: new Date(T0).toISOString(),
      },
    });
    expect(String(e.payload.transcript)).toContain("Acme Excavation");
  });

  it("flags events Vapi waits on synchronously", () => {
    const e = provider().parseWebhookRequest(vapiRequest(vapiAssistantRequest()));
    expect(e).toMatchObject({ eventType: "call.assistant_request", requiresResponse: true });
  });

  it.each([
    ["not JSON", "{nope"],
    ["no message", JSON.stringify({})],
    ["no call id", JSON.stringify({ message: { type: "status-update", status: "ringing" } })],
  ])("rejects %s as a client error", (_name, rawBody) => {
    const req = vapiRequest({});
    expect(() => provider().parseWebhookRequest({ ...req, rawBody })).toThrow(WebhookPayloadError);
  });

  it("rejects non-JSON content types", () => {
    const req = vapiRequest(vapiStatusUpdate("ringing"));
    req.headers.set("content-type", "application/x-www-form-urlencoded");
    expect(() => provider().parseWebhookRequest(req)).toThrow(WebhookPayloadError);
  });
});

describe("Vapi outbound calls", () => {
  it("transfers with one request and classifies failures", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: VAPI_CALL_ID, status: "forwarding" }), { status: 200 }),
      );
    const result = await provider(fetchFn).transferCall({
      organizationId: "o",
      providerCallId: VAPI_CALL_ID,
      toNumber: "+15125550199",
      operationId: "op",
    });
    expect(result).toEqual({ providerCallId: VAPI_CALL_ID, status: "transferred" });
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`https://api.vapi.ai/call/${VAPI_CALL_ID}/control`);

    const failing = vi.fn<typeof fetch>().mockResolvedValue(new Response("down", { status: 502 }));
    await expect(
      provider(failing).transferCall({
        organizationId: "o",
        providerCallId: VAPI_CALL_ID,
        toNumber: "x",
        operationId: "op",
      }),
    ).rejects.toMatchObject({ kind: "ambiguous" });
  });

  it("reads a call's current status for reconciliation", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: VAPI_CALL_ID,
          status: "ended",
          endedReason: "assistant-forwarded-call",
        }),
        { status: 200 },
      ),
    );
    await expect(provider(fetchFn).getCall(VAPI_CALL_ID)).resolves.toEqual({
      providerCallId: VAPI_CALL_ID,
      status: "ended",
      endedReason: "assistant-forwarded-call",
    });
  });
});
