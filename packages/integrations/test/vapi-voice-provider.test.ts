import { describe, expect, it, vi } from "vitest";
import { VapiVoiceProvider } from "../src/adapters/vapi-voice-provider";

const CONFIG = {
  apiKey: "test-api-key",
  webhookSecret: "test-webhook-secret",
  apiBaseUrl: "https://api.vapi.test",
};

function jsonResponse(body: unknown, ok = true, status = 201) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("VapiVoiceProvider.createInboundRoute", () => {
  it("posts to the Vapi phone-number endpoint with bearer auth and JSON body", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ id: "pn-1", number: "+15550000000" }));
    const provider = new VapiVoiceProvider({ ...CONFIG, fetchFn });

    const route = await provider.createInboundRoute({
      organizationId: "org-1",
      phoneNumber: "+15550000000",
      webhookUrl: "https://example.test/webhooks/voice",
    });

    expect(route).toEqual({ providerRouteId: "pn-1", phoneNumber: "+15550000000" });
    const [url, init] = fetchFn.mock.calls.at(0) ?? [];
    expect(url).toBe("https://api.vapi.test/phone-number");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-api-key");
    const body = JSON.parse(init.body as string);
    expect(body.number).toBe("+15550000000");
    expect(body.server).toEqual({ url: "https://example.test/webhooks/voice", secret: "test-webhook-secret" });
  });
});

describe("VapiVoiceProvider.initiateOutboundCall", () => {
  const baseRequest = {
    organizationId: "org-1",
    fromNumber: "+15550000000",
    toNumber: "+15551111111",
    idempotencyKey: "call-key-1",
  };

  it("posts to the Vapi call endpoint with bearer auth and JSON body", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ id: "call-1", status: "queued" }));
    const provider = new VapiVoiceProvider({ ...CONFIG, fetchFn });

    const result = await provider.initiateOutboundCall(baseRequest);

    expect(result).toEqual({ providerCallId: "call-1", status: "queued" });
    const [url, init] = fetchFn.mock.calls.at(0) ?? [];
    expect(url).toBe("https://api.vapi.test/call");
    expect(init.headers.Authorization).toBe("Bearer test-api-key");
    const body = JSON.parse(init.body as string);
    expect(body.phoneNumber).toEqual({ number: "+15550000000" });
    expect(body.customer).toEqual({ number: "+15551111111" });
  });

  it("maps Vapi call statuses", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ id: "call-2", status: "in-progress" }));
    const provider = new VapiVoiceProvider({ ...CONFIG, fetchFn });

    const result = await provider.initiateOutboundCall({ ...baseRequest, idempotencyKey: "call-key-2" });
    expect(result.status).toBe("in_progress");
  });

  it("is idempotent for calls with the same key and does not call Vapi twice", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ id: "call-3", status: "queued" }));
    const provider = new VapiVoiceProvider({ ...CONFIG, fetchFn });

    const first = await provider.initiateOutboundCall(baseRequest);
    const second = await provider.initiateOutboundCall(baseRequest);

    expect(second).toEqual(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("distinguishes idempotency keys across organizations", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "call-org-a", status: "queued" }))
      .mockResolvedValueOnce(jsonResponse({ id: "call-org-b", status: "queued" }));
    const provider = new VapiVoiceProvider({ ...CONFIG, fetchFn });

    const orgA = await provider.initiateOutboundCall({ ...baseRequest, organizationId: "org-a", idempotencyKey: "same-key" });
    const orgB = await provider.initiateOutboundCall({ ...baseRequest, organizationId: "org-b", idempotencyKey: "same-key" });

    expect(orgA.providerCallId).not.toBe(orgB.providerCallId);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("throws when Vapi responds with a non-2xx status", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ message: "invalid number" }, false, 400));
    const provider = new VapiVoiceProvider({ ...CONFIG, fetchFn });

    await expect(provider.initiateOutboundCall(baseRequest)).rejects.toThrow(/Vapi call creation failed with status 400/);
  });
});

describe("VapiVoiceProvider.transferCall", () => {
  const baseRequest = {
    organizationId: "org-1",
    providerCallId: "call-1",
    toNumber: "+15552222222",
    idempotencyKey: "transfer-key-1",
  };

  it("posts to the Vapi call control endpoint and maps the resulting status", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ id: "call-1", status: "forwarding" }));
    const provider = new VapiVoiceProvider({ ...CONFIG, fetchFn });

    const result = await provider.transferCall(baseRequest);

    expect(result).toEqual({ providerCallId: "call-1", status: "transferred" });
    const [url, init] = fetchFn.mock.calls.at(0) ?? [];
    expect(url).toBe("https://api.vapi.test/call/call-1/control");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ type: "transfer", destination: { type: "number", number: "+15552222222" } });
  });

  it("is idempotent for transfers with the same key and does not call Vapi twice", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ id: "call-1", status: "forwarding" }));
    const provider = new VapiVoiceProvider({ ...CONFIG, fetchFn });

    const first = await provider.transferCall(baseRequest);
    const second = await provider.transferCall(baseRequest);

    expect(second).toEqual(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws when Vapi responds with a non-2xx status", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ message: "call not found" }, false, 404));
    const provider = new VapiVoiceProvider({ ...CONFIG, fetchFn });

    await expect(provider.transferCall(baseRequest)).rejects.toThrow(/Vapi call transfer failed with status 404/);
  });
});

describe("VapiVoiceProvider.verifyWebhookSignature", () => {
  const rawBody = JSON.stringify({ message: { type: "status-update", call: { id: "call-1" } } });

  it("accepts a request carrying the configured shared secret", () => {
    const provider = new VapiVoiceProvider(CONFIG);
    const headers = new Headers({ "x-vapi-secret": CONFIG.webhookSecret });

    expect(provider.verifyWebhookSignature(rawBody, headers)).toBe(true);
  });

  it("rejects a request carrying the wrong secret", () => {
    const provider = new VapiVoiceProvider(CONFIG);
    const headers = new Headers({ "x-vapi-secret": "wrong-secret" });

    expect(provider.verifyWebhookSignature(rawBody, headers)).toBe(false);
  });

  it("rejects a missing secret header", () => {
    const provider = new VapiVoiceProvider(CONFIG);
    expect(provider.verifyWebhookSignature(rawBody, new Headers())).toBe(false);
  });
});

describe("VapiVoiceProvider.ingestWebhook", () => {
  it("normalizes a server message into a provider webhook event", async () => {
    const provider = new VapiVoiceProvider(CONFIG);
    const message = { type: "status-update", call: { id: "call-1" }, status: "in-progress" };
    const event = await provider.ingestWebhook({ message });

    expect(event).toEqual({
      provider: "vapi",
      providerEventId: "call-1",
      payload: message,
    });
  });

  it("throws when the payload has no call id", async () => {
    const provider = new VapiVoiceProvider(CONFIG);
    await expect(provider.ingestWebhook({ message: { type: "status-update" } })).rejects.toThrow(
      /message.call.id/,
    );
  });
});
