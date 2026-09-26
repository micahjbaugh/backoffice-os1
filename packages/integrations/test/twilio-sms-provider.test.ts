import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TwilioSmsProvider } from "../src/adapters/twilio-sms-provider";

const CONFIG = {
  accountSid: "AC-test-sid",
  authToken: "test-auth-token",
  webhookUrl: "https://example.test/webhooks/sms",
  apiBaseUrl: "https://api.twilio.test",
};

function jsonResponse(body: unknown, ok = true, status = 201) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("TwilioSmsProvider.sendSMS", () => {
  const baseRequest = {
    organizationId: "org-1",
    fromNumber: "+15550000000",
    toNumber: "+15551111111",
    body: "hello",
    idempotencyKey: "sms-key-1",
  };

  it("posts to the Twilio Messages endpoint with Basic auth and form body", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ sid: "SM123", status: "queued" }));
    const provider = new TwilioSmsProvider({ ...CONFIG, fetchFn });

    const result = await provider.sendSMS(baseRequest);

    expect(result).toEqual({ providerMessageId: "SM123", status: "queued" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls.at(0) ?? [];
    expect(url).toBe("https://api.twilio.test/2010-04-01/Accounts/AC-test-sid/Messages.json");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from("AC-test-sid:test-auth-token").toString("base64")}`,
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get("To")).toBe("+15551111111");
    expect(body.get("From")).toBe("+15550000000");
    expect(body.get("Body")).toBe("hello");
    expect(body.get("StatusCallback")).toBe(CONFIG.webhookUrl);
  });

  it("maps Twilio delivery statuses", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ sid: "SM124", status: "delivered" }));
    const provider = new TwilioSmsProvider({ ...CONFIG, fetchFn });

    const result = await provider.sendSMS({ ...baseRequest, idempotencyKey: "sms-key-2" });
    expect(result.status).toBe("delivered");
  });

  it("is idempotent for sends with the same key and does not call Twilio twice", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ sid: "SM125", status: "queued" }));
    const provider = new TwilioSmsProvider({ ...CONFIG, fetchFn });

    const first = await provider.sendSMS(baseRequest);
    const second = await provider.sendSMS(baseRequest);

    expect(second).toEqual(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("distinguishes idempotency keys across organizations", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ sid: "SM-org-a", status: "queued" }))
      .mockResolvedValueOnce(jsonResponse({ sid: "SM-org-b", status: "queued" }));
    const provider = new TwilioSmsProvider({ ...CONFIG, fetchFn });

    const orgA = await provider.sendSMS({
      ...baseRequest,
      organizationId: "org-a",
      idempotencyKey: "same-key",
    });
    const orgB = await provider.sendSMS({
      ...baseRequest,
      organizationId: "org-b",
      idempotencyKey: "same-key",
    });

    expect(orgA.providerMessageId).not.toBe(orgB.providerMessageId);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("throws when Twilio responds with a non-2xx status", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: "invalid number" }, false, 400));
    const provider = new TwilioSmsProvider({ ...CONFIG, fetchFn });

    await expect(provider.sendSMS(baseRequest)).rejects.toThrow(
      /Twilio send failed with status 400/,
    );
  });
});

describe("TwilioSmsProvider.verifyWebhookSignature", () => {
  function signAsTwilio(webhookUrl: string, authToken: string, rawBody: string): string {
    const params = new URLSearchParams(rawBody);
    const sortedKeys = Array.from(new Set(params.keys())).sort();
    const data = webhookUrl + sortedKeys.map((k) => `${k}${params.get(k)}`).join("");
    return createHmac("sha1", authToken).update(data).digest("base64");
  }

  const rawBody = "MessageSid=SM123&MessageStatus=delivered&To=%2B15551111111";

  it("accepts a validly signed request", () => {
    const provider = new TwilioSmsProvider(CONFIG);
    const signature = signAsTwilio(CONFIG.webhookUrl, CONFIG.authToken, rawBody);
    const headers = new Headers({ "x-twilio-signature": signature });

    expect(provider.verifyWebhookSignature(rawBody, headers)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const provider = new TwilioSmsProvider(CONFIG);
    const signature = signAsTwilio(CONFIG.webhookUrl, CONFIG.authToken, rawBody);
    const headers = new Headers({ "x-twilio-signature": signature });
    const tamperedBody = "MessageSid=SM999&MessageStatus=delivered&To=%2B15551111111";

    expect(provider.verifyWebhookSignature(tamperedBody, headers)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    const provider = new TwilioSmsProvider(CONFIG);
    expect(provider.verifyWebhookSignature(rawBody, new Headers())).toBe(false);
  });
});

describe("TwilioSmsProvider.ingestWebhook", () => {
  it("normalizes a status callback into a provider webhook event", async () => {
    const provider = new TwilioSmsProvider(CONFIG);
    const event = await provider.ingestWebhook({ MessageSid: "SM123", MessageStatus: "delivered" });

    expect(event).toEqual({
      provider: "twilio",
      providerEventId: "SM123",
      payload: { MessageSid: "SM123", MessageStatus: "delivered" },
    });
  });

  it("throws when the payload has no message identifier", async () => {
    const provider = new TwilioSmsProvider(CONFIG);
    await expect(provider.ingestWebhook({ MessageStatus: "delivered" })).rejects.toThrow(
      /MessageSid/,
    );
  });
});
