import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError, TwilioSmsProvider, WebhookPayloadError } from "../src";
import {
  BUSINESS_NUMBER,
  CUSTOMER_NUMBER,
  MESSAGE_SID,
  OUTBOUND_MESSAGE_SID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WEBHOOK_URL,
  twilioInboundSms,
  twilioRequest,
  twilioSign,
  twilioStatusCallback,
} from "./fixtures/providers";

const provider = (fetchFn?: typeof fetch) =>
  new TwilioSmsProvider({
    accountSid: TWILIO_ACCOUNT_SID,
    authToken: TWILIO_AUTH_TOKEN,
    webhookUrl: TWILIO_WEBHOOK_URL,
    fetchFn,
  });

describe("Twilio signature verification", () => {
  it("matches Twilio's published worked example (docs: Twilio security)", () => {
    // https://www.twilio.com/docs/usage/security — URL, token, params and expected value copied verbatim.
    const params = {
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675310",
      Digits: "1234",
      From: "+14158675310",
      To: "+18005551212",
    };
    const docs = new TwilioSmsProvider({
      accountSid: TWILIO_ACCOUNT_SID,
      authToken: "12345",
      webhookUrl: "https://example.com/myapp.php",
    });
    const request = {
      rawBody: new URLSearchParams(params).toString(),
      headers: new Headers({
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "L/OH5YylLD5NRKLltdqwSvS0BnU=",
      }),
      url: "http://internal/myapp.php?foo=1&bar=2",
    };
    expect(docs.verifyWebhookRequest(request)).toBe(true);
    expect(twilioSign("12345", "https://example.com/myapp.php?foo=1&bar=2", params)).toBe(
      "L/OH5YylLD5NRKLltdqwSvS0BnU=",
    );
  });

  it("verifies a real-shaped inbound SMS against the public URL, not the internal one", () => {
    expect(provider().verifyWebhookRequest(twilioRequest(twilioInboundSms()))).toBe(true);
  });

  it("covers the query string Twilio signed (status callback carrying the operation id)", () => {
    const req = twilioRequest(twilioStatusCallback("sent"), { query: "?op=op-123" });
    expect(provider().verifyWebhookRequest(req)).toBe(true);
    expect(
      provider().verifyWebhookRequest({ ...req, url: req.url.replace("op-123", "op-999") }),
    ).toBe(false);
  });

  it("rejects tampering, wrong token, missing header and non-form content types", () => {
    const req = twilioRequest(twilioInboundSms());
    expect(
      provider().verifyWebhookRequest({ ...req, rawBody: req.rawBody.replace("Wilson", "Smith") }),
    ).toBe(false);
    expect(
      provider().verifyWebhookRequest(
        twilioRequest(twilioInboundSms(), { token: "some-other-auth-token-000" }),
      ),
    ).toBe(false);
    const noSig = new Headers(req.headers);
    noSig.delete("x-twilio-signature");
    expect(provider().verifyWebhookRequest({ ...req, headers: noSig })).toBe(false);
    const json = new Headers(req.headers);
    json.set("content-type", "application/json");
    expect(provider().verifyWebhookRequest({ ...req, headers: json })).toBe(false);
  });

  it("handles repeated keys like twilio-node (de-duplicated, sorted values)", () => {
    const url = `${TWILIO_WEBHOOK_URL}`;
    const rawBody = "Body=hi&MediaUrl0=b&MediaUrl0=a&MediaUrl0=a&MessageSid=" + MESSAGE_SID;
    // Expected string built by hand: keys sorted, MediaUrl0 values de-duplicated and sorted (a, b).
    const expected = createHmac("sha1", TWILIO_AUTH_TOKEN)
      .update(`${url}BodyhiMediaUrl0aMediaUrl0bMessageSid${MESSAGE_SID}`)
      .digest("base64");
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": expected,
    });
    expect(
      provider().verifyWebhookRequest({
        rawBody,
        headers,
        url: "http://internal/api/webhooks/sms",
      }),
    ).toBe(true);
  });
});

describe("Twilio webhook parsing", () => {
  it("parses a form-encoded inbound SMS (the JSON-only handler used to reject these)", () => {
    const event = provider().parseWebhookRequest(
      twilioRequest(twilioInboundSms(), { idempotencyToken: "tok-1" }),
    );
    expect(event).toMatchObject({
      provider: "twilio",
      channel: "sms",
      eventType: "sms.inbound",
      eventKey: `${MESSAGE_SID}:inbound`,
      resourceId: MESSAGE_SID,
      deliveryId: "tok-1",
      routingAddress: BUSINESS_NUMBER,
      payload: {
        messageSid: MESSAGE_SID,
        from: CUSTOMER_NUMBER,
        to: BUSINESS_NUMBER,
        body: "Me Jake Tyler 7-5:30 Wilson. Hoe 8 hrs",
        mediaUrls: [],
      },
    });
  });

  it("gives each status of one message its own event identity (no dedupe collision)", () => {
    const keys = ["queued", "sent", "delivered"].map(
      (s) => provider().parseWebhookRequest(twilioRequest(twilioStatusCallback(s))).eventKey,
    );
    expect(new Set(keys).size).toBe(3);
    expect(keys[2]).toBe(`${OUTBOUND_MESSAGE_SID}:delivered`);
  });

  it("gives a retry of the same status the same identity", () => {
    const a = provider().parseWebhookRequest(
      twilioRequest(twilioStatusCallback("sent"), { idempotencyToken: "retry-1" }),
    );
    const b = provider().parseWebhookRequest(
      twilioRequest(twilioStatusCallback("sent"), { idempotencyToken: "retry-1" }),
    );
    expect(a.eventKey).toBe(b.eventKey);
  });

  it("carries status rank, error code and the outbox operation id", () => {
    const event = provider().parseWebhookRequest(
      twilioRequest(twilioStatusCallback("undelivered", { ErrorCode: "30003" }), {
        query: "?op=op-42",
      }),
    );
    expect(event.payload).toMatchObject({
      status: "undelivered",
      statusRank: 7,
      errorCode: "30003",
      operationId: "op-42",
    });
    expect(event.routingAddress).toBe(BUSINESS_NUMBER);
  });

  it.each([
    ["missing MessageSid", twilioInboundSms({ MessageSid: "" })],
    ["malformed MessageSid", twilioInboundSms({ MessageSid: "not-a-sid" })],
    ["unknown status", twilioStatusCallback("exploded")],
    ["no body and no status", { MessageSid: MESSAGE_SID, AccountSid: TWILIO_ACCOUNT_SID }],
  ])("rejects %s as a client error", (_name, params) => {
    expect(() => provider().parseWebhookRequest(twilioRequest(params))).toThrow(
      WebhookPayloadError,
    );
  });

  it("rejects webhooks for a different Twilio account", () => {
    expect(() =>
      provider().parseWebhookRequest(
        twilioRequest(twilioInboundSms({ AccountSid: "AC" + "f".repeat(32) })),
      ),
    ).toThrow(/different Twilio account/);
  });
});

describe("Twilio sendSMS", () => {
  const ok = (body: unknown, status = 201) =>
    // A fresh Response per call: a body can only be read once.
    vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(body), { status }));

  it("posts one form-encoded request with the operation id on the status callback", async () => {
    const fetchFn = ok({ sid: OUTBOUND_MESSAGE_SID, status: "queued" });
    const result = await provider(fetchFn).sendSMS({
      organizationId: "org",
      fromNumber: BUSINESS_NUMBER,
      toNumber: CUSTOMER_NUMBER,
      body: "On our way",
      operationId: "op-7",
    });
    expect(result).toEqual({ providerMessageId: OUTBOUND_MESSAGE_SID, status: "queued" });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    );
    const form = new URLSearchParams(String(init.body));
    expect(form.get("StatusCallback")).toBe(`${TWILIO_WEBHOOK_URL}?op=op-7`);
    expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^Basic /);
  });

  it.each([
    [400, "rejected", false],
    [429, "rejected", true],
    [500, "ambiguous", false],
    [503, "ambiguous", false],
  ])("classifies HTTP %i as %s (retryable=%s)", async (status, kind, retryable) => {
    const err = await provider(ok({ message: "x" }, status))
      .sendSMS({
        organizationId: "org",
        fromNumber: BUSINESS_NUMBER,
        toNumber: CUSTOMER_NUMBER,
        body: "x",
        operationId: "op",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err).toMatchObject({ kind, retryable });
  });

  it("treats a timeout as ambiguous and an unreachable host as not sent", async () => {
    const timeout = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    await expect(
      provider(timeout).sendSMS({
        organizationId: "o",
        fromNumber: "a",
        toNumber: "b",
        body: "c",
        operationId: "d",
      }),
    ).rejects.toMatchObject({ kind: "ambiguous" });
    const refused = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));
    await expect(
      provider(refused).sendSMS({
        organizationId: "o",
        fromNumber: "a",
        toNumber: "b",
        body: "c",
        operationId: "d",
      }),
    ).rejects.toMatchObject({ kind: "rejected", retryable: true });
  });

  it("does not remember sends in memory (the outbox owns idempotency)", async () => {
    const fetchFn = ok({ sid: OUTBOUND_MESSAGE_SID, status: "queued" });
    const p = provider(fetchFn);
    const req = {
      organizationId: "org",
      fromNumber: BUSINESS_NUMBER,
      toNumber: CUSTOMER_NUMBER,
      body: "x",
      operationId: "op",
    };
    await p.sendSMS(req);
    await p.sendSMS(req);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
